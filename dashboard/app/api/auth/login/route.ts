// Kicks off the Discord OAuth2 flow: set a random anti-CSRF state cookie and
// redirect the user to Discord's consent screen.
import { NextResponse } from 'next/server';
import { buildAuthorizeUrl, STATE_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600, // 10 minutes to complete the flow
  });
  return res;
}
