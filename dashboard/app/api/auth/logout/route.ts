import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { requestOrigin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function logout(req: NextRequest) {
  const supabase = createClient(await cookies());
  await supabase.auth.signOut();
  return NextResponse.redirect(
    new URL('/login', requestOrigin((name) => req.headers.get(name), req.nextUrl.origin)),
  );
}

export const GET = logout;
export const POST = logout;
