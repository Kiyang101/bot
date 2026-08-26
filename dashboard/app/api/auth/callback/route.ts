import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { GUEST_LINK_COOKIE, homePathFor, sessionUserFromSupabaseUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function loginError(req: NextRequest, reason: string) {
  const url = new URL('/login', req.url);
  url.searchParams.set('error', reason);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return loginError(req, req.nextUrl.searchParams.get('error') ? 'denied' : 'exchange');

  const supabase = createClient(await cookies());
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return loginError(req, 'exchange');

  const user = sessionUserFromSupabaseUser(data.user);
  if (!user) {
    await supabase.auth.signOut();
    return loginError(req, 'forbidden');
  }

  const response = NextResponse.redirect(new URL(homePathFor(user.role), req.url));
  response.cookies.delete(GUEST_LINK_COOKIE);
  return response;
}
