// Auth gate for the whole dashboard.
//   • No / invalid session  → redirect to /login
//   • Signed in but page is above your role → redirect to your home page
// The /login page and /api/auth/* routes are always public so the flow can run.
import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  GUILD_COOKIE,
  GUEST_LINK_COOKIE,
  verifySession,
  devBypassUser,
  guestUserForHost,
  linkGuestUser,
  publicLinkEnabled,
  capRoleForHost,
  requestHost,
  canAccess,
  homePathFor,
} from '@/lib/auth';

const PUBLIC_PREFIXES = ['/login', '/api/auth'];

const YEAR = 60 * 60 * 24 * 365;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const host = requestHost((n) => req.headers.get(n));

  // A ?guild= link (e.g. from the bot's /dashboard command) pins the dashboard
  // to that server: stash it in the cookie and strip the param. Done before the
  // auth gate so the selection survives the login round-trip.
  const guildParam = req.nextUrl.searchParams.get('guild');
  if (guildParam) {
    const url = new URL(req.nextUrl);
    url.searchParams.delete('guild');
    const res = NextResponse.redirect(url);
    res.cookies.set(GUILD_COOKIE, guildParam, { path: '/', sameSite: 'lax', maxAge: YEAR });

    // Public-link mode: a visitor who isn't genuinely logged in gets a no-login
    // guest locked to THIS server. Only a real session (dev bypass or a signed
    // login) blocks the link path — a host-based guest still lets the link pin
    // its own server, overriding the GUEST_GUILD_ID default. Logged-in users
    // keep their session and aren't locked; the link just pins like the switcher.
    const realSession =
      devBypassUser() ?? (await verifySession(req.cookies.get(SESSION_COOKIE)?.value));
    if (!realSession && publicLinkEnabled()) {
      res.cookies.set(GUEST_LINK_COOKIE, guildParam, { path: '/', sameSite: 'lax', maxAge: YEAR });
    }
    return res;
  }

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const resolved =
    devBypassUser() ??
    (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) ??
    guestUserForHost(host) ??
    linkGuestUser(req.cookies.get(GUEST_LINK_COOKIE)?.value);
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
