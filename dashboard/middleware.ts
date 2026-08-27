// Refresh Supabase Auth sessions and apply the dashboard's role/access rules.
import { NextResponse, type NextRequest } from 'next/server';
import {
  DASHBOARD_LINK_GUILD_COOKIE,
  GUILD_COOKIE,
  capRoleForHost,
  canAccess,
  devBypassUser,
  homePathFor,
  roleFromDatabase,
  requestHost,
  sessionUserFromSupabaseUser,
} from '@/lib/auth';
import { updateSession } from '@/lib/supabase/middleware';

const PUBLIC_PREFIXES = ['/login', '/api/auth'];
const YEAR = 60 * 60 * 24 * 365;

function redirectWithSession(url: URL, source: NextResponse): NextResponse {
  const response = NextResponse.redirect(url);
  source.cookies.getAll().forEach(({ name, value }) => response.cookies.set(name, value));
  return response;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const host = requestHost((name) => req.headers.get(name));
  const { response: supabaseResponse, supabase, user: authUser } = await updateSession(req);
  const roleResult = authUser
    ? await supabase.from('DashboardUser').select('role').eq('id', authUser.id).maybeSingle()
    : null;
  if (roleResult?.error) throw new Error(`read DashboardUser: ${roleResult.error.message}`);
  const realSession =
    devBypassUser() ?? sessionUserFromSupabaseUser(authUser, roleFromDatabase(roleResult?.data?.role));

  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))) {
    return supabaseResponse;
  }

  const guildParam = req.nextUrl.searchParams.get('guild');
  if (guildParam) {
    const url = new URL(req.nextUrl);
    url.searchParams.delete('guild');
    const response = redirectWithSession(url, supabaseResponse);
    response.cookies.set(GUILD_COOKIE, guildParam, { path: '/', sameSite: 'lax', maxAge: YEAR });

    response.cookies.set(DASHBOARD_LINK_GUILD_COOKIE, guildParam, {
      path: '/',
      sameSite: 'lax',
      maxAge: YEAR,
    });
    return response;
  }

  const resolved = realSession;
  if (!resolved) {
    return redirectWithSession(new URL('/login', req.url), supabaseResponse);
  }

  const user = capRoleForHost(resolved, host);
  if (!canAccess(user.role, pathname)) {
    return redirectWithSession(new URL(homePathFor(user.role), req.url), supabaseResponse);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
