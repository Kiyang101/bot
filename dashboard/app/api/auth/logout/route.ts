import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

async function logout(req: NextRequest) {
  const supabase = createClient(await cookies());
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', req.url));
}

export const GET = logout;
export const POST = logout;
