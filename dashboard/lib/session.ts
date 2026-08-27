// Server-only helpers for Supabase Auth sessions and application roles.
import { cookies, headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  capRoleForHost,
  devBypassUser,
  roleFromDatabase,
  requestHost,
  sessionUserFromSupabaseUser,
  type Role,
  type SessionUser,
} from '@/lib/auth';

export async function getSessionUser(): Promise<SessionUser | null> {
  const hdrs = await headers();
  const host = requestHost((name) => hdrs.get(name));
  const store = await cookies();
  const db = createClient(store);
  const { data } = await db.auth.getUser();
  const roleResult = data.user
    ? await db.from('DashboardUser').select('role').eq('id', data.user.id).maybeSingle()
    : null;
  if (roleResult?.error) throw new Error(`read DashboardUser: ${roleResult.error.message}`);
  const resolved =
    devBypassUser() ?? sessionUserFromSupabaseUser(data.user, roleFromDatabase(roleResult?.data?.role));
  return resolved ? capRoleForHost(resolved, host) : null;
}

export async function requireRole(role: Role): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated.');
  if (role === 'admin' && user.role !== 'admin') throw new Error('Admins only.');
  return user;
}
