// Discord OAuth2 + session handling for the dashboard.
//
// Two roles, decided by allowlists in the environment:
//   • admin  — the bot owner(s); full access to every page.
//   • member — other people you explicitly allow; Speak + Music pages only.
// Anyone not in either list is denied even after a successful Discord login.
//
// The session is a short, signed JWT stored in an httpOnly cookie. We use `jose`
// because it works in the Edge middleware runtime (node:crypto does not).
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'megu_session';
export const STATE_COOKIE = 'megu_oauth_state';
const SESSION_TTL = '7d';

export type Role = 'admin' | 'member';

export interface SessionUser {
  id: string;
  username: string;
  avatar: string | null;
  role: Role;
}

/** Pages each role is allowed to open. Members are confined to Speak + Music. */
export const ROLE_PATHS: Record<Role, string[]> = {
  admin: ['/', '/speak', '/music', '/config'],
  member: ['/speak', '/music'],
};

/** Where to send a user after login / when they hit a page above their role. */
export function homePathFor(role: Role): string {
  return role === 'admin' ? '/' : '/music';
}

/** True if `role` may view `pathname` (ignoring query string). */
export function canAccess(role: Role, pathname: string): boolean {
  const allowed = ROLE_PATHS[role];
  return allowed.some((p) => pathname === p || pathname.startsWith(p + '/'));
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
  return ['localhost', '127.0.0.1', '::1'];
}

/** Pull the request host, preferring the forwarded host ngrok sets. */
export function requestHost(get: (name: string) => string | null | undefined): string | null {
  return get('x-forwarded-host') ?? get('host') ?? null;
}

/** True when the request came in on a trusted local host. */
export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.split(':')[0].toLowerCase();
  return localHosts().includes(h);
}

/**
 * Cap an admin down to member when the request is NOT from a local host (i.e.
 * it came in over ngrok / the public internet). Members are returned unchanged.
 * This is what limits remote visitors to the Speak + Music pages.
 */
export function capRoleForHost(user: SessionUser, host: string | null | undefined): SessionUser {
  if (user.role === 'admin' && !isLocalHost(host)) {
    return { ...user, role: 'member' };
  }
  return user;
}

function parseIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
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
  if (admins.has(userId)) return 'admin';
  if (members.has(userId)) return 'member';
  return null;
}

/**
 * Local-dev escape hatch: when DEV_AUTH_BYPASS is set to "admin" or "member"
 * AND we're not in production, treat every request as a signed-in user of that
 * role — no Discord login needed. Returns null in production or when unset, so
 * it can never weaken a real deployment.
 */
export function devBypassUser(): SessionUser | null {
  if (process.env.NODE_ENV === 'production') return null;
  const role = process.env.DEV_AUTH_BYPASS;
  if (role !== 'admin' && role !== 'member') return null;
  const id = parseIds(process.env.ADMIN_USER_IDS).values().next().value ?? 'dev';
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
export function guestUserForHost(host: string | null | undefined): SessionUser | null {
  const role = process.env.PUBLIC_GUEST_ACCESS;
  if (role !== 'admin' && role !== 'member') return null;
  if (isLocalHost(host)) return null;
  return { id: 'guest', username: 'guest', avatar: null, role };
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

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return new TextEncoder().encode(secret);
}

/** Sign a session JWT for the given user. */
export async function createSession(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secretKey());
}

/** Verify a session JWT; returns the user or null if missing/invalid/expired. */
export async function verifySession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const { id, username, avatar, role } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || (role !== 'admin' && role !== 'member')) return null;
    return {
      id,
      username: typeof username === 'string' ? username : 'unknown',
      avatar: typeof avatar === 'string' ? avatar : null,
      role,
    };
  } catch {
    return null;
  }
}

// ─── Discord OAuth2 endpoints / helpers ──────────────────────────────────────

const DISCORD_AUTH = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const DISCORD_USER = 'https://discord.com/api/users/@me';

function redirectUri(): string {
  return process.env.OAUTH_REDIRECT_URI ?? 'http://localhost:3000/api/auth/callback';
}

/** Build the Discord consent URL to send the user to, embedding an anti-CSRF state. */
export function buildAuthorizeUrl(state: string): string {
  const clientId = process.env.CLIENT_ID;
  if (!clientId) throw new Error('CLIENT_ID is not set');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'consent',
  });
  return `${DISCORD_AUTH}?${params.toString()}`;
}

/** Exchange an OAuth `code` for an access token. */
async function exchangeCode(code: string): Promise<string> {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('CLIENT_ID / DISCORD_CLIENT_SECRET not set');

  const res = await fetch(DISCORD_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('no access_token in token response');
  return data.access_token;
}

export interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

/** Fetch the logged-in Discord user with an access token. */
async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(DISCORD_USER, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`fetch user failed (${res.status})`);
  const u = (await res.json()) as { id: string; username: string; avatar: string | null };
  return { id: u.id, username: u.username, avatar: u.avatar };
}

/** Full code → token → user round-trip, used by the callback route. */
export async function exchangeCodeForUser(code: string): Promise<DiscordUser> {
  const token = await exchangeCode(code);
  return fetchDiscordUser(token);
}
