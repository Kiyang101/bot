// Server-only helpers for Supabase Auth sessions and application roles.
import { cookies, headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  GUEST_LINK_COOKIE,
  capRoleForHost,
  devBypassUser,
  guestUserForHost,
  linkGuestUser,
  requestHost,
  sessionUserFromSupabaseUser,
  type Role,
  type SessionUser,
} from '@/lib/auth';

export async function getSessionUser(): Promise<SessionUser | null> {
  const hdrs = await headers();
  const host = requestHost((name) => hdrs.get(name));
  const store = await cookies();
  const { data } = await createClient(store).auth.getUser();
  const resolved =
    devBypassUser() ??
    sessionUserFromSupabaseUser(data.user) ??
    guestUserForHost(host) ??
    linkGuestUser(store.get(GUEST_LINK_COOKIE)?.value);
  return resolved ? capRoleForHost(resolved, host) : null;
}

export async function requireRole(role: Role): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated.');
  if (role === 'admin' && user.role !== 'admin') throw new Error('Admins only.');
  return user;
}
