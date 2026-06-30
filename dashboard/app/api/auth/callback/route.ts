// Discord redirects here with ?code & ?state. We verify the state, exchange the
// code for the user's Discord identity, check the allowlist, and — if allowed —
// issue a signed session cookie. Otherwise we bounce back to /login with an error.
import { NextResponse, type NextRequest } from 'next/server';
import {
  STATE_COOKIE,
  SESSION_COOKIE,
  createSession,
  exchangeCodeForUser,
  roleForUser,
  homePathFor,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

function loginError(req: NextRequest, reason: string) {
  const url = new URL('/login', req.url);
  url.searchParams.set('error', reason);
  const res = NextResponse.redirect(url);
  res.cookies.delete(STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const stateCookie = req.cookies.get(STATE_COOKIE)?.value;

  if (searchParams.get('error')) return loginError(req, 'denied');
  if (!code || !state || !stateCookie || state !== stateCookie) {
    return loginError(req, 'state');
  }

  let user;
  try {
    user = await exchangeCodeForUser(code);
  } catch {
    return loginError(req, 'exchange');
  }

  const role = roleForUser(user.id);
  if (!role) return loginError(req, 'forbidden');

  const token = await createSession({
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    role,
  });

  const res = NextResponse.redirect(new URL(homePathFor(role), req.url));
  res.cookies.delete(STATE_COOKIE);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days, matching the JWT TTL
  });
  return res;
}
