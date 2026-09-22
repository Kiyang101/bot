import 'server-only';
import { assertSupabaseResult } from './database';
import { createAdminClient } from './supabase/admin';

export type SpeechProvider = 'google' | 'voicevox';
export interface EntrancePreference {
  enabled: boolean; soundId: string | null; mode?: 'sound' | 'speech';
  speechText?: string | null; speechProvider?: SpeechProvider | null;
  speechVoice?: string | null; speechPath?: string | null; speechDurationSec?: number | null;
}

export async function getEntrancePreference(guildId: string, userId: string): Promise<EntrancePreference> {
  const row = assertSupabaseResult('read entrance preference', await createAdminClient()
    .from('VoiceEntrancePreference').select('enabled,soundId,mode,speechText,speechProvider,speechVoice,speechPath,speechDurationSec').eq('guildId', guildId).eq('userId', userId).maybeSingle());
  return { enabled: row?.enabled === true, soundId: row?.soundId ?? null,
    mode: row?.mode === 'speech' ? 'speech' : 'sound', speechText: row?.speechText ?? null,
    speechProvider: row?.speechProvider ?? null, speechVoice: row?.speechVoice ?? null,
    speechPath: row?.speechPath ?? null, speechDurationSec: row?.speechDurationSec ?? null };
}

export async function saveEntrancePreference(guildId: string, userId: string, preference: EntrancePreference): Promise<void> {
  assertSupabaseResult('save entrance preference', await createAdminClient().from('VoiceEntrancePreference').upsert({
    guildId, userId, enabled: preference.enabled, mode: preference.mode ?? 'sound', soundId: preference.soundId,
    speechText: preference.speechText ?? null, speechProvider: preference.speechProvider ?? null,
    speechVoice: preference.speechVoice ?? null, speechPath: preference.speechPath ?? null,
    speechDurationSec: preference.speechDurationSec ?? null,
    updatedAt: new Date().toISOString(),
  }, { onConflict: 'guildId,userId' }));
}
