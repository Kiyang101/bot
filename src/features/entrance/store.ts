import { getSupabaseAdmin } from '../../infrastructure/supabase';
import { assertSupabaseResult } from '../../infrastructure/database';
import { ENTRANCE_MAX_SECONDS, ENTRANCE_MIN_SECONDS, type EntrancePreference, type EntranceSound } from './types';

export async function readEntrancePreference(guildId: string, userId: string): Promise<EntrancePreference | null> {
  return assertSupabaseResult('read entrance preference', await getSupabaseAdmin()
    .from('VoiceEntrancePreference').select('enabled,soundId,mode,speechPath,speechDurationSec').eq('guildId', guildId).eq('userId', userId).maybeSingle());
}

export async function resolveEntranceSpeech(guildId: string, userId: string, preference: EntrancePreference): Promise<EntranceSound | null> {
  const path = preference.speechPath;
  const durationSec = Number(preference.speechDurationSec);
  if (!/^\d+$/.test(guildId) || !/^\d+$/.test(userId) || !path
    || !new RegExp(`^entrances/${guildId}/${userId}/[0-9a-f-]{36}\\.wav$`).test(path)
    || !Number.isFinite(durationSec) || durationSec < ENTRANCE_MIN_SECONDS || durationSec > ENTRANCE_MAX_SECONDS) return null;
  const db = getSupabaseAdmin();
  const signed = assertSupabaseResult('sign entrance speech', await db.storage.from('sounds').createSignedUrl(path, 60));
  if (!signed?.signedUrl) return null;
  const current = assertSupabaseResult('recheck entrance speech', await db.from('VoiceEntrancePreference')
    .select('enabled,mode,speechPath,speechDurationSec').eq('guildId', guildId).eq('userId', userId).maybeSingle());
  if (!current?.enabled || current.mode !== 'speech' || current.speechPath !== path || Number(current.speechDurationSec) !== durationSec) return null;
  return { url: signed.signedUrl, durationSec, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
}

export async function resolveEntranceSound(soundId: string): Promise<EntranceSound | null> {
  const db = getSupabaseAdmin();
  const sound = assertSupabaseResult('read entrance sound', await db.from('Sound').select('*').eq('id', soundId).maybeSingle());
  if (!sound) return null;
  const durationSec = Number(sound.durationSec);
  if (sound.durationSec == null || !Number.isFinite(durationSec) || durationSec < ENTRANCE_MIN_SECONDS || durationSec > ENTRANCE_MAX_SECONDS) return null;
  const path = String(sound.storagePath);
  const prefix = `sounds/${sound.uploadedById}/${sound.id}/playable`;
  if (path !== prefix && !/^-[^/\\]+$/.test(path.slice(prefix.length))) return null;
  if (!path.startsWith(prefix)) return null;
  const lease = assertSupabaseResult('check sound mutation', await db.from('SoundMutationLease').select('*').eq('soundId', soundId).maybeSingle());
  if (lease) return null;
  const recovery = assertSupabaseResult('check sound recovery', await db.from('SoundMutationRecovery').select('id').eq('soundId', soundId).limit(1));
  if (recovery?.length) return null;
  const signed = assertSupabaseResult('sign entrance sound', await db.storage.from('sounds').createSignedUrl(path, 60));
  if (!signed?.signedUrl) return null;
  const current = assertSupabaseResult('recheck entrance sound', await db.from('Sound').select('storagePath,durationSec').eq('id', soundId).maybeSingle());
  if (!current || current.storagePath !== path || Number(current.durationSec) !== durationSec) return null;
  return { url: signed.signedUrl, durationSec, gainDb: Number(sound.gainDb), fadeInMs: Number(sound.fadeInMs), fadeOutMs: Number(sound.fadeOutMs) };
}
