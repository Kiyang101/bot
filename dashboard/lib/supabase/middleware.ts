import { createServerClient as createSupabaseServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

export function isRecoverableSupabaseAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; code?: string };
  if (candidate.name !== 'AuthApiError') return false;
  const recoverableCodes = new Set([
    'refresh_token_already_used',
    'refresh_token_not_found',
    'session_expired',
  ]);
  return typeof candidate.code === 'string' && recoverableCodes.has(candidate.code);
}

export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set.');

  let response = NextResponse.next({ request: { headers: request.headers } });
  const supabase = createSupabaseServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      if (error.name === 'AuthSessionMissingError' || isRecoverableSupabaseAuthError(error)) {
        return { response, supabase, user: null };
      }
      throw error;
    }
    return { response, supabase, user: data.user };
  } catch (error) {
    if (isRecoverableSupabaseAuthError(error)) {
      return { response, supabase, user: null };
    }
    throw error;
  }
}
