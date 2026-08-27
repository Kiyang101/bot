// Dashboard authorization helpers.
//
// Two roles, stored in Supabase:
//   • admin  — full access to every page.
//   • member — Speak + Music pages only.
//
// Which Discord server the dashboard is pinned to (set by the GuildSwitcher or a
// ?guild= link). Declared here so the edge middleware can import it without
// pulling in next/headers via lib/guild.
export const GUILD_COOKIE = "guildId";
// Holds the guild selected by a server-scoped dashboard link. It is only a
// selection lock; it never authenticates the visitor.
export const DASHBOARD_LINK_GUILD_COOKIE = "megu_dashboard_link_guild";
export type Role = "admin" | "member";
export const DEFAULT_DASHBOARD_ROLE: Role = "member";

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

export function roleFromDatabase(value: unknown): Role | null {
  return value === "admin" || value === "member" ? value : null;
}

export interface DiscordProfile {
  discordId: string;
  username: string;
  avatar: string | null;
}

/** Extract display data from a verified Supabase Discord identity. */
export function discordProfileFromSupabaseUser(
  user: SupabaseAuthUser | null,
): DiscordProfile | null {
  if (!user) return null;
  const identity = user.identities?.find(
    (candidate) => candidate.provider === "discord",
  );
  const discordId = identity?.provider_id ?? identity?.id;
  if (!discordId) return null;

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
  return { discordId, username, avatar };
}

/** Convert a verified Supabase Discord identity and database role into a user. */
export function sessionUserFromSupabaseUser(
  user: SupabaseAuthUser | null,
  role: unknown = null,
): SessionUser | null {
  const profile = discordProfileFromSupabaseUser(user);
  const validRole = roleFromDatabase(role);
  if (!profile || !validRole) return null;
  return { id: profile.discordId, username: profile.username, avatar: profile.avatar, role: validRole };
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
  const id = `dev-${role}`;
  return { id, username: `dev-${role}`, avatar: null, role };
}

/**
 * When REMOTE_GUILD_ID is set, remote (ngrok) visitors are locked to that one
 * server — they can't view or switch to any other. Returns the forced guild id
 * for non-local requests, or null on local hosts / when unset (admins keep the
 * full server switcher).
 */
export function forcedGuildId(host: string | null | undefined): string | null {
  const id = process.env.REMOTE_GUILD_ID;
  if (!id) return null;
  if (isLocalHost(host)) return null;
  return id;
}

/** The guild a /dashboard link is locked to, or null if not applicable. */
export function dashboardLinkGuildId(
  guildFromCookie: string | undefined | null,
): string | null {
  if (!guildFromCookie) return null;
  return guildFromCookie;
}
