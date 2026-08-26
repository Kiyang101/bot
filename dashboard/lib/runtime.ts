import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { assertSupabaseResult } from '@/lib/database';
import type { BotRuntime, BotStatus } from '@/lib/control';

/** Read the last persisted lifecycle state when the bot endpoint is offline. */
export async function readBotRuntime(): Promise<BotRuntime | null> {
  const runtime = assertSupabaseResult(
    'read BotRuntime',
    await createClient(await cookies()).from('BotRuntime').select('*').eq('id', 1).maybeSingle(),
  );
  if (!runtime) return null;
  return {
    id: runtime.id,
    status: runtime.status as BotStatus,
    pid: runtime.pid,
    startedAt: runtime.startedAt ?? null,
    stoppedAt: runtime.stoppedAt ?? null,
    lastError: runtime.lastError,
    updatedAt: runtime.updatedAt,
  };
}
