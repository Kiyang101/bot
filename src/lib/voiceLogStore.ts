import { prisma } from './db';
import type { VoiceAction } from '@prisma/client';

// --- Per-server log channel config (table: GuildConfig) ---

/** Returns the configured log channel ID for a server, or null if none. */
export async function getLogChannel(guildId: string): Promise<string | null> {
  const config = await prisma.guildConfig.findUnique({ where: { guildId } });
  return config?.logChannelId ?? null;
}

/** Sets (creates or updates) the log channel for a server. */
export async function setLogChannel(guildId: string, channelId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, logChannelId: channelId },
    update: { logChannelId: channelId },
  });
}

/** Disables logging for a server by clearing its channel. */
export async function clearLogChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, logChannelId: null },
    update: { logChannelId: null },
  });
}

// --- Voice event history (table: VoiceEvent) ---

export interface VoiceEventInput {
  guildId: string;
  userId: string;
  username: string;
  action: VoiceAction;
  channelId?: string | null;
  channelName?: string | null;
  fromChannelId?: string | null;
  fromChannelName?: string | null;
}

/** Records one voice action so the dashboard can show a history. */
export async function recordVoiceEvent(event: VoiceEventInput): Promise<void> {
  await prisma.voiceEvent.create({ data: event });
}
