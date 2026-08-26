import { assertSupabaseResult } from './database';
import { getSupabaseAdmin } from './supabase';

const now = () => new Date().toISOString();

/** Persisted lifecycle state shared with the dashboard. The singleton row has id 1. */
export async function markBotStarting(pid: number): Promise<void> {
  assertSupabaseResult(
    'mark bot starting',
    await getSupabaseAdmin().from('BotRuntime').upsert(
      { id: 1, status: 'STARTING', pid, startedAt: now(), stoppedAt: null, lastError: null, updatedAt: now() },
      { onConflict: 'id' },
    ),
  );
}

export async function markBotRunning(pid: number): Promise<void> {
  assertSupabaseResult(
    'mark bot running',
    await getSupabaseAdmin().from('BotRuntime').upsert(
      { id: 1, status: 'RUNNING', pid, startedAt: now(), stoppedAt: null, lastError: null, updatedAt: now() },
      { onConflict: 'id' },
    ),
  );
}

export async function markBotStopping(): Promise<void> {
  assertSupabaseResult(
    'mark bot stopping',
    await getSupabaseAdmin().from('BotRuntime').update({ status: 'STOPPING', updatedAt: now() }).eq('id', 1),
  );
}

export async function markBotStopped(): Promise<void> {
  assertSupabaseResult(
    'mark bot stopped',
    await getSupabaseAdmin().from('BotRuntime').upsert(
      { id: 1, status: 'STOPPED', pid: null, stoppedAt: now(), lastError: null, updatedAt: now() },
      { onConflict: 'id' },
    ),
  );
}

export async function markBotError(error: unknown): Promise<void> {
  const lastError = error instanceof Error ? error.message : String(error);
  assertSupabaseResult(
    'mark bot error',
    await getSupabaseAdmin().from('BotRuntime').upsert(
      { id: 1, status: 'ERROR', pid: null, lastError, updatedAt: now() },
      { onConflict: 'id' },
    ),
  );
}
