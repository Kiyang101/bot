import { prisma } from './db';

/** Persisted lifecycle state shared with the dashboard. The singleton row has id 1. */
export async function markBotStarting(pid: number): Promise<void> {
  await prisma.botRuntime.upsert({
    where: { id: 1 },
    create: { id: 1, status: 'STARTING', pid, startedAt: new Date(), lastError: null },
    update: { status: 'STARTING', pid, startedAt: new Date(), stoppedAt: null, lastError: null },
  });
}

export async function markBotRunning(pid: number): Promise<void> {
  await prisma.botRuntime.upsert({
    where: { id: 1 },
    create: { id: 1, status: 'RUNNING', pid, startedAt: new Date(), lastError: null },
    update: { status: 'RUNNING', pid, stoppedAt: null, lastError: null },
  });
}

export async function markBotStopping(): Promise<void> {
  await prisma.botRuntime.updateMany({
    where: { id: 1 },
    data: { status: 'STOPPING' },
  });
}

export async function markBotStopped(): Promise<void> {
  await prisma.botRuntime.upsert({
    where: { id: 1 },
    create: { id: 1, status: 'STOPPED', stoppedAt: new Date() },
    update: { status: 'STOPPED', pid: null, stoppedAt: new Date(), lastError: null },
  });
}

export async function markBotError(error: unknown): Promise<void> {
  const lastError = error instanceof Error ? error.message : String(error);
  await prisma.botRuntime.upsert({
    where: { id: 1 },
    create: { id: 1, status: 'ERROR', pid: null, lastError },
    update: { status: 'ERROR', pid: null, lastError },
  });
}
