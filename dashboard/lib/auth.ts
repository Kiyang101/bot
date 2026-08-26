// Dashboard authorization helpers.
//
// Two roles, decided by allowlists in the environment:
//   • admin  — the bot owner(s); full access to every page.
//   • member — other people you explicitly allow; Speak + Music pages only.
// Anyone not in either list is denied even after a successful Discord login.
//
// Which Discord server the dashboard is pinned to (set by the GuildSwitcher or a
// ?guild= link). Declared here so the edge middleware can import it without
// pulling in next/headers via lib/guild.
export const GUILD_COOKIE = "guildId";
// Marks a no-login session granted by a server-scoped /dashboard link, holding
// the guild that link is locked to. Distinct from GUILD_COOKIE so a logged-in
// admin's normal server pin is never confused with a public guest lock.
export const GUEST_LINK_COOKIE = "megu_guest_guild";
export type Role = "admin" | "member";

export interface SessionUser {
  id: string;
  username: string;
  avatar: string | null;
  role: Role;
}

/** Pages each role is allowed to open. Members are confined to Speak + Music. */
export const ROLE_PATHS: Record<Role, string[]> = {
  admin: ["/", "/speak", "/music", "/config"],
  member: ["/speak", "/music"],
};

/** Where to send a user after login / when they hit a page above their role. */
export function homePathFor(role: Role): string {
  return role === "admin" ? "/" : "/music";
}

/** True if `role` may view `pathname` (ignoring query string). */
export function canAccess(role: Role, pathname: string): boolean {
  const allowed = ROLE_PATHS[role];
  return allowed.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Hosts considered "local" — requests arriving on these keep their full role.
 * Anything else (e.g. an ngrok tunnel, a LAN IP) is treated as public and an
 * admin is capped down to member. Override the default list with LOCAL_HOSTS.
 */
function localHosts(): string[] {
  const raw = process.env.LOCAL_HOSTS;
  if (raw) {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return ["localhost", "127.0.0.1", "::1"];
}

/** Pull the request host, preferring the forwarded host ngrok sets. */
export function requestHost(
  get: (name: string) => string | null | undefined,
): string | null {
  return get("x-forwarded-host") ?? get("host") ?? null;
}

/** True when the request came in on a trusted local host. */
export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.split(":")[0].toLowerCase();
  return localHosts().includes(h);
}

/**
 * Cap an admin down to member when the request is NOT from a local host (i.e.
 * it came in over ngrok / the public internet). Members are returned unchanged.
 * This is what limits remote visitors to the Speak + Music pages.
 */
export function capRoleForHost(
  user: SessionUser,
  host: string | null | undefined,
): SessionUser {
  if (user.role === "admin" && !isLocalHost(host)) {
    return { ...user, role: "member" };
  }
  return user;
}

function parseIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Resolve a Discord user id to a role, or null if they're not allowed in.
 * Admin wins if an id appears in both lists.
 */
export function roleForUser(userId: string): Role | null {
  const admins = parseIds(process.env.ADMIN_USER_IDS);
  const members = parseIds(process.env.MEMBER_USER_IDS);
  if (admins.has(userId)) return "admin";
  if (members.has(userId)) return "member";
  return null;
}

/** Alias with an explicit provider-oriented name for Supabase Auth callers. */
export function resolveRoleForDiscordId(discordId: string): Role | null {
  return roleForUser(discordId);
}

export interface SupabaseDiscordIdentity {
  id?: string;
  provider: string;
  provider_id?: string;
  identity_data?: Record<string, unknown> | null;
}

export interface SupabaseAuthUser {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: SupabaseDiscordIdentity[] | null;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

/** Convert a verified Supabase Discord identity into the app's role-aware user. */
export function sessionUserFromSupabaseUser(
  user: SupabaseAuthUser | null,
): SessionUser | null {
  if (!user) return null;
  const identity = user.identities?.find(
    (candidate) => candidate.provider === "discord",
  );
  const discordId = identity?.provider_id ?? identity?.id;
  if (!discordId) return null;

  const role = resolveRoleForDiscordId(discordId);
  if (!role) return null;

  const data = identity?.identity_data ?? {};
  const metadata = user.user_metadata ?? {};
  const username =
    firstNonEmptyString(
      data.username,
      metadata.username,
      data.preferred_username,
      metadata.preferred_username,
      data.user_name,
      metadata.user_name,
      data.global_name,
      metadata.global_name,
      data.display_name,
      metadata.display_name,
      data.full_name,
      metadata.full_name,
      data.name,
      metadata.name,
    ) ?? "Discord user";

  const avatar = typeof data.avatar === "string" ? data.avatar : null;

  return { id: discordId, username, avatar, role };
}

/**
 * Local-dev escape hatch: when DEV_AUTH_BYPASS is set to "admin" or "member"
 * AND we're not in production, treat every request as a signed-in user of that
 * role — no Discord login needed. Returns null in production or when unset, so
 * it can never weaken a real deployment.
 */
export function devBypassUser(): SessionUser | null {
  if (process.env.NODE_ENV === "production") return null;
  const role = process.env.DEV_AUTH_BYPASS;
  if (role !== "admin" && role !== "member") return null;
  const id =
    parseIds(process.env.ADMIN_USER_IDS).values().next().value ?? "dev";
  return { id, username: `dev-${role}`, avatar: null, role };
}

/**
 * Public guest access for remote (ngrok) visitors. When PUBLIC_GUEST_ACCESS is
 * set to "member" (or "admin"), any request arriving on a NON-local host is
 * auto-signed-in as a guest of that role with no Discord login. Local requests
 * are unaffected, so your own machine still uses normal admin auth.
 *
 * Returns null on local hosts or when the flag is unset. Note that even with
 * "admin", capRoleForHost() still caps remote guests to member.
 */
export function guestUserForHost(
  host: string | null | undefined,
): SessionUser | null {
  const role = process.env.PUBLIC_GUEST_ACCESS;
  if (role !== "admin" && role !== "member") return null;
  if (isLocalHost(host)) return null;
  return { id: "guest", username: "guest", avatar: null, role };
}

/**
 * When GUEST_GUILD_ID is set, remote (ngrok) visitors are locked to that one
 * server — they can't view or switch to any other. Returns the forced guild id
 * for non-local requests, or null on local hosts / when unset (admins keep the
 * full server switcher).
 */
export function forcedGuildId(host: string | null | undefined): string | null {
  const id = process.env.GUEST_GUILD_ID;
  if (!id) return null;
  if (isLocalHost(host)) return null;
  return id;
}

/**
 * Public no-login /dashboard links are off unless DASHBOARD_PUBLIC_LINK is set
 * to "true"/"1". Until then a ?guild= link only pins the server for users who
 * are already authenticated the normal way.
 */
export function publicLinkEnabled(): boolean {
  const v = process.env.DASHBOARD_PUBLIC_LINK?.toLowerCase();
  return v === "true" || v === "1";
}

/**
 * No-login guest granted by a server-scoped /dashboard link. When public links
 * are enabled and the guest-link cookie names a guild, the visitor is treated as
 * a member (Speak + Music only), locked to that one server. Returns null when
 * the feature is off or there's no link cookie.
 */
export function linkGuestUser(
  guildFromCookie: string | undefined | null,
): SessionUser | null {
  if (!publicLinkEnabled() || !guildFromCookie) return null;
  return { id: "guest", username: "guest", avatar: null, role: "member" };
}

/** The guild a /dashboard-link guest is locked to, or null if not applicable. */
export function linkGuestGuildId(
  guildFromCookie: string | undefined | null,
): string | null {
  if (!publicLinkEnabled() || !guildFromCookie) return null;
  return guildFromCookie;
}
