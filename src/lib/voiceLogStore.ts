import { getSupabaseAdmin } from './supabase';
import { assertSupabaseResult, VoiceAction, type VoiceAction as VoiceActionType } from './database';

const now = () => new Date().toISOString();

// --- Per-server log channel config (table: GuildConfig) ---

/** Returns the configured log channel ID for a server, or null if none. */
export async function getLogChannel(guildId: string): Promise<string | null> {
  const config = assertSupabaseResult(
    'read GuildConfig',
    await getSupabaseAdmin()
      .from('GuildConfig')
      .select('logChannelId')
      .eq('guildId', guildId)
      .maybeSingle(),
  );
  return config?.logChannelId ?? null;
}

/** Sets (creates or updates) the log channel for a server. */
export async function setLogChannel(guildId: string, channelId: string): Promise<void> {
  assertSupabaseResult(
    'write GuildConfig',
    await getSupabaseAdmin().from('GuildConfig').upsert(
      { guildId, logChannelId: channelId, updatedAt: now() },
      { onConflict: 'guildId' },
    ),
  );
}

/** Disables logging for a server by clearing its channel. */
export async function clearLogChannel(guildId: string): Promise<void> {
  assertSupabaseResult(
    'clear GuildConfig',
    await getSupabaseAdmin().from('GuildConfig').upsert(
      { guildId, logChannelId: null, updatedAt: now() },
      { onConflict: 'guildId' },
    ),
  );
}

// --- Voice event history (table: VoiceEvent) ---

export interface VoiceEventInput {
  guildId: string;
  userId: string;
  username: string;
  action: VoiceActionType;
  channelId?: string | null;
  channelName?: string | null;
  fromChannelId?: string | null;
  fromChannelName?: string | null;
}

/** Records one voice action so the dashboard can show a history. */
export async function recordVoiceEvent(event: VoiceEventInput): Promise<void> {
  assertSupabaseResult('write VoiceEvent', await getSupabaseAdmin().from('VoiceEvent').insert(event));
}

export { VoiceAction };
