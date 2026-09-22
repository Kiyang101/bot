import 'server-only';
import { randomUUID } from 'node:crypto';
import { assertSupabaseResult } from './database';
import { createAdminClient } from './supabase/admin';
import { sendPreview } from './control';
import { trimSourceFile } from './audio';
import { MAX_SOUND_BYTES } from './sound-validation';
import { listVoicevoxSpeakers } from './voicevox';
import type { SpeechProvider } from './entrance';

export const MAX_ENTRANCE_SPEECH_CHARS = 80;
export const GOOGLE_VOICES = [
  { id: 'th', name: 'Thai ไทย' }, { id: 'en', name: 'English' },
  { id: 'ja', name: 'Japanese 日本語' }, { id: 'ko', name: 'Korean 한국어' },
  { id: 'zh-CN', name: 'Chinese 中文' }, { id: 'vi', name: 'Vietnamese' },
  { id: 'id', name: 'Indonesian' }, { id: 'fr', name: 'French' },
  { id: 'de', name: 'German' }, { id: 'es', name: 'Spanish' },
  { id: 'ru', name: 'Russian' }, { id: 'hi', name: 'Hindi' },
];

const SPEECH_PATH = /^entrances\/\d+\/\d+\/[0-9a-f-]{36}\.wav$/;

export async function validateSpeechInput(text: string, provider: SpeechProvider, voice: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_ENTRANCE_SPEECH_CHARS) throw new Error(`Speech must be 1–${MAX_ENTRANCE_SPEECH_CHARS} characters.`);
  if (provider === 'google') {
    if (!GOOGLE_VOICES.some((choice) => choice.id === voice)) throw new Error('Choose a supported language.');
  } else if (provider === 'voicevox') {
    const voices = await listVoicevoxSpeakers();
    if (!voices.some((choice) => choice.id === voice)) throw new Error('Choose an available VOICEVOX speaker.');
  } else throw new Error('Choose a supported speech provider.');
  return trimmed;
}

export async function synthesizeEntranceSpeech(text: string, provider: SpeechProvider, voice: string): Promise<{ buffer: Buffer; durationSec: number }> {
  const result = await sendPreview({ text, provider, voice, translate: false });
  if (result.audio.byteLength > MAX_SOUND_BYTES) throw new Error('Synthesized speech is too large.');
  const processed = await trimSourceFile({
    source: Buffer.from(result.audio), mimeType: result.contentType.split(';')[0].toLowerCase(),
    trimStartMs: 0, trimEndMs: null,
  });
  if (processed.durationSec < 0.1 || processed.durationSec > 5) throw new Error('Synthesized speech must be between 0.1 and 5 seconds.');
  return { buffer: processed.buffer, durationSec: processed.durationSec };
}

export async function uploadEntranceSpeech(guildId: string, userId: string, buffer: Buffer): Promise<string> {
  if (!/^\d+$/.test(guildId) || !/^\d+$/.test(userId)) throw new Error('Invalid speech asset identity.');
  const path = `entrances/${guildId}/${userId}/${randomUUID()}.wav`;
  const storage = createAdminClient().storage.from('sounds');
  try {
    assertSupabaseResult('upload entrance speech', await storage.upload(path, buffer, { contentType: 'audio/wav', upsert: false }));
  } catch (error) {
    await storage.remove([path]).catch(() => {});
    throw error;
  }
  return path;
}

export async function queueSpeechCleanup(path: string): Promise<void> {
  if (!SPEECH_PATH.test(path)) throw new Error('Invalid speech asset path.');
  assertSupabaseResult('queue entrance speech cleanup', await createAdminClient().from('VoiceEntranceSpeechCleanup').upsert({ path }, { onConflict: 'path' }));
}

export async function cleanupEntranceSpeech(): Promise<void> {
  const db = createAdminClient();
  const rows = assertSupabaseResult('list entrance speech cleanup', await db.from('VoiceEntranceSpeechCleanup').select('path').is('removedAt', null).order('createdAt').limit(20));
  for (const row of rows ?? []) {
    const path = String(row.path);
    if (!SPEECH_PATH.test(path)) continue;
    const live = assertSupabaseResult('check entrance speech reference', await db.from('VoiceEntrancePreference').select('guildId').eq('speechPath', path).limit(1));
    if (live?.length) continue;
    const removed = await db.storage.from('sounds').remove([path]);
    if (removed.error) continue;
    assertSupabaseResult('finish entrance speech cleanup', await db.from('VoiceEntranceSpeechCleanup').update({ removedAt: new Date().toISOString() }).eq('path', path));
  }
}

export async function previewSavedSpeech(guildId: string, userId: string): Promise<string> {
  const row = assertSupabaseResult('check entrance speech', await createAdminClient().from('VoiceEntrancePreference')
    .select('speechPath').eq('guildId', guildId).eq('userId', userId).maybeSingle());
  const path = row?.speechPath;
  if (typeof path !== 'string' || !path.startsWith(`entrances/${guildId}/${userId}/`) || !SPEECH_PATH.test(path)) throw new Error('Saved speech is unavailable.');
  const signed = assertSupabaseResult('sign entrance speech', await createAdminClient().storage.from('sounds').createSignedUrl(path, 60));
  if (!signed?.signedUrl) throw new Error('Speech preview unavailable.');
  return signed.signedUrl;
}
