// Auth gate for the whole dashboard.
//   • No / invalid session  → redirect to /login
//   • Signed in but page is above your role → redirect to your home page
// The /login page and /api/auth/* routes are always public so the flow can run.
import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  verifySession,
  devBypassUser,
  guestUserForHost,
  capRoleForHost,
  requestHost,
  canAccess,
  homePathFor,
} from '@/lib/auth';

const PUBLIC_PREFIXES = ['/login', '/api/auth'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const host = requestHost((n) => req.headers.get(n));
  const resolved =
    devBypassUser() ??
    (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) ??
    guestUserForHost(host);
  if (!resolved) {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }

  // Remote (ngrok) visitors are capped to member, so they only see Speak + Music.
  const user = capRoleForHost(resolved, host);

  if (!canAccess(user.role, pathname)) {
    return NextResponse.redirect(new URL(homePathFor(user.role), req.url));
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
