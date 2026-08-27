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

export interface SessionOptions {
  /** Allow a real admin to use admin-only remote routes such as /config. */
  allowRemoteAdmin?: boolean;
}

export async function getSessionUser(options: SessionOptions = {}): Promise<SessionUser | null> {
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
  return resolved
    ? options.allowRemoteAdmin
      ? resolved
      : capRoleForHost(resolved, host)
    : null;
}

export async function requireRole(role: Role, options: SessionOptions = {}): Promise<SessionUser> {
  const user = await getSessionUser(options);
  if (!user) throw new Error('Not authenticated.');
  if (role === 'admin' && user.role !== 'admin') throw new Error('Admins only.');
  return user;
}
