import { spawn } from 'node:child_process';
import path from 'node:path';
import { prisma } from '@/lib/prisma';

const ROOT_DIR = process.env.BOT_WORKDIR ?? process.env.BOT_ROOT_DIR ?? path.resolve(process.cwd(), '..');
const START_COMMAND = process.env.BOT_START_COMMAND ?? 'npm run start';

/** Launch the bot as a detached process owned by the dashboard host. */
export async function startManagedBot(): Promise<number> {
  await prisma.botRuntime.upsert({
    where: { id: 1 },
    create: { id: 1, status: 'STARTING', lastError: null },
    update: { status: 'STARTING', pid: null, startedAt: new Date(), stoppedAt: null, lastError: null },
  });

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
      void prisma.botRuntime.updateMany({
        where: { id: 1, status: 'STARTING' },
        data: { status: 'ERROR', pid: null, lastError: error.message },
      });
    });
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) return;
      void prisma.botRuntime.updateMany({
        where: { id: 1, status: { in: ['STARTING', 'RUNNING'] } },
        data: {
          status: 'ERROR',
          pid: null,
          lastError: signal
            ? `Bot process exited on ${signal}.`
            : `Bot process exited unexpectedly (code ${code}).`,
        },
      });
    });

    await prisma.botRuntime.updateMany({ where: { id: 1 }, data: { pid } });
    return pid;
  } catch (error) {
    await prisma.botRuntime.updateMany({
      where: { id: 1 },
      data: { status: 'ERROR', pid: null, lastError: error instanceof Error ? error.message : String(error) },
    });
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
