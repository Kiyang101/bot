import { spawn } from 'node:child_process';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertSupabaseResult } from '@/lib/database';

const database = () => createAdminClient();

const ROOT_DIR = process.env.BOT_WORKDIR ?? process.env.BOT_ROOT_DIR ?? path.resolve(process.cwd(), '..');
const START_COMMAND = process.env.BOT_START_COMMAND ?? 'npm run start';

async function updateRuntime(
  operation: string,
  values: Record<string, unknown>,
  filters: (query: any) => any,
): Promise<void> {
  const query = filters(database().from('BotRuntime').update({ ...values, updatedAt: new Date().toISOString() }));
  assertSupabaseResult(operation, await query);
}

/** Launch the bot as a detached process owned by the dashboard host. */
export async function startManagedBot(): Promise<number> {
  assertSupabaseResult(
    'start bot runtime',
    await database().from('BotRuntime').upsert(
      { id: 1, status: 'STARTING', pid: null, startedAt: new Date().toISOString(), stoppedAt: null, lastError: null, updatedAt: new Date().toISOString() },
      { onConflict: 'id' },
    ),
  );

  try {
    const child = spawn(START_COMMAND, {
      cwd: ROOT_DIR,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      shell: true,
    });

    const pid = child.pid;
    if (!pid) throw new Error('The bot process did not return a PID.');
    child.unref();

    child.once('error', (error) => {
      void updateRuntime('record bot process error', { status: 'ERROR', pid: null, lastError: error.message }, (query) =>
        query.eq('id', 1).eq('status', 'STARTING'),
      ).catch((updateError) => console.error('[bot-process] failed to store process error:', updateError));
    });
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) return;
      void updateRuntime(
        'record bot process exit',
        {
          status: 'ERROR',
          pid: null,
          lastError: signal
            ? `Bot process exited on ${signal}.`
            : `Bot process exited unexpectedly (code ${code}).`,
        },
        (query) => query.eq('id', 1).in('status', ['STARTING', 'RUNNING']),
      ).catch((updateError) => console.error('[bot-process] failed to store process exit:', updateError));
    });

    assertSupabaseResult(
      'store bot pid',
      await database().from('BotRuntime').update({ pid, updatedAt: new Date().toISOString() }).eq('id', 1),
    );
    return pid;
  } catch (error) {
    assertSupabaseResult(
      'mark bot start error',
      await database()
        .from('BotRuntime')
        .update({ status: 'ERROR', pid: null, lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() })
        .eq('id', 1),
    );
    throw error;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Last-resort cleanup when the control endpoint is unavailable. */
export async function forceStopProcess(pid: number): Promise<void> {
  if (!processIsAlive(pid)) return;
  if (process.platform === 'win32') {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (error) => (error ? reject(error) : resolve()));
    });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}
