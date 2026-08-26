import { prisma } from '@/lib/prisma';
import type { BotRuntime, BotStatus } from '@/lib/control';

/** Read the last persisted lifecycle state when the bot endpoint is offline. */
export async function readBotRuntime(): Promise<BotRuntime | null> {
  const runtime = await prisma.botRuntime.findUnique({ where: { id: 1 } });
  if (!runtime) return null;
  return {
    id: runtime.id,
    status: runtime.status as BotStatus,
    pid: runtime.pid,
    startedAt: runtime.startedAt?.toISOString() ?? null,
    stoppedAt: runtime.stoppedAt?.toISOString() ?? null,
    lastError: runtime.lastError,
    updatedAt: runtime.updatedAt.toISOString(),
  };
}
