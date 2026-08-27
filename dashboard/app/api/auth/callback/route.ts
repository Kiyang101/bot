import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertSupabaseResult } from '@/lib/database';
import {
  DEFAULT_DASHBOARD_ROLE,
  discordProfileFromSupabaseUser,
  homePathFor,
  requestOrigin,
  sessionUserFromSupabaseUser,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

function loginError(req: NextRequest, reason: string) {
  const url = new URL('/login', requestOrigin((name) => req.headers.get(name), req.nextUrl.origin));
  url.searchParams.set('error', reason);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return loginError(req, req.nextUrl.searchParams.get('error') ? 'denied' : 'exchange');

  const supabase = createClient(await cookies());
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return loginError(req, 'exchange');

  const profile = discordProfileFromSupabaseUser(data.user);
  if (!profile) {
    await supabase.auth.signOut();
    return loginError(req, 'forbidden');
  }

  const dashboardUser = assertSupabaseResult(
    'write DashboardUser',
    // Omit role on update so an admin promotion is never reset by login.
    await createAdminClient().from('DashboardUser').upsert(
      {
        id: data.user.id,
        discordId: profile.discordId,
        username: profile.username,
        avatar: profile.avatar,
        updatedAt: new Date().toISOString(),
      },
      { onConflict: 'id' },
    ).select('role').single(),
  );
  const user = sessionUserFromSupabaseUser(
    data.user,
    dashboardUser?.role ?? DEFAULT_DASHBOARD_ROLE,
  );
  if (!user) {
    await supabase.auth.signOut();
    return loginError(req, 'forbidden');
  }

  const response = NextResponse.redirect(
    new URL(homePathFor(user.role), requestOrigin((name) => req.headers.get(name), req.nextUrl.origin)),
  );
  return response;
}
