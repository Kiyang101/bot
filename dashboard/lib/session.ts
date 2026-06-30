// Server-only helpers to read the current session inside Server Components and
// Server Actions. Kept separate from lib/auth.ts (which the Edge middleware
// imports) because next/headers can't be used in the middleware runtime.
import { cookies, headers } from 'next/headers';
import {
  SESSION_COOKIE,
  verifySession,
  devBypassUser,
  guestUserForHost,
  capRoleForHost,
  requestHost,
  type Role,
  type SessionUser,
} from '@/lib/auth';

/**
 * The signed-in user for this request, or null if not authenticated.
 * Remote (ngrok) visitors may be granted guest access, and admins reaching the
 * app over a non-local host are capped to member — both matching the middleware
 * so the nav and page guards stay consistent.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const hdrs = await headers();
  const host = requestHost((n) => hdrs.get(n));
  const resolved = devBypassUser() ?? (await readCookieSession()) ?? guestUserForHost(host);
  if (!resolved) return null;
  return capRoleForHost(resolved, host);
}

async function readCookieSession(): Promise<SessionUser | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/**
 * Guard for sensitive Server Actions. Throws if the caller isn't signed in or
 * lacks the required role. Middleware already gates pages by role, but actions
 * are POST endpoints too, so we re-check here as defense in depth.
 */
export async function requireRole(role: Role): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated.');
  if (role === 'admin' && user.role !== 'admin') throw new Error('Admins only.');
  return user;
}
