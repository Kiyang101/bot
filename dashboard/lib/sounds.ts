import { assertSupabaseResult } from './database';
import { mapSoundRow as mapValidatedSoundRow } from './sound-validation';
import type { SoundRecord } from './sound-types';
import { createAdminClient } from './supabase/admin';

const SOUND_BUCKET = 'sounds';
const SIGNED_URL_TTL_SECONDS = 60 * 5;

type StorageFile = Blob | ArrayBuffer | Uint8Array;
type SoundStorageIdentity = { uploadedById: string; soundId: string };

function requireStorageIdentifier(value: string, label: string): string {
  if (!value || value.includes('/') || value.includes('\\')) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function soundPath({ uploadedById, soundId }: SoundStorageIdentity, object: 'source' | 'playable'): string {
  return `sounds/${requireStorageIdentifier(uploadedById, 'Uploader id')}/${requireStorageIdentifier(soundId, 'Sound id')}/${object}`;
}

function isSoundPath(path: string): boolean {
  return /^sounds\/[^/\\]+\/[^/\\]+\/(source|playable)$/.test(path);
}

/** Maps raw server-only Sound rows to the client-safe domain record. */
export const mapSoundRow = mapValidatedSoundRow;

/** Lists the global sound library; it deliberately has no guild filter. */
export async function listSounds(): Promise<SoundRecord[]> {
  const result = await createAdminClient()
    .from('Sound')
    .select('*')
    .order('sortOrder', { ascending: true })
    .order('createdAt', { ascending: true });
  const rows = assertSupabaseResult('list sounds', result) ?? [];
  return rows.map(mapSoundRow);
}

/** Looks up one global sound record by id. */
export async function getSound(id: string): Promise<SoundRecord | null> {
  const result = await createAdminClient().from('Sound').select('*').eq('id', id).maybeSingle();
  const row = assertSupabaseResult('get sound', result);
  return row ? mapSoundRow(row) : null;
}

/** Creates a short-lived URL for an internal Sound storage object. */
export async function getSignedSoundUrl(path: string): Promise<string> {
  if (!isSoundPath(path)) throw new Error('Sound storage path is invalid.');
  const result = await createAdminClient().storage.from(SOUND_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  const signed = assertSupabaseResult('create sound signed URL', result);
  if (!signed?.signedUrl) throw new Error('create sound signed URL: no signed URL was returned.');
  return signed.signedUrl;
}

/** Uploads an original source file to its fixed owner/sound path. */
export async function uploadSource(input: SoundStorageIdentity & { file: StorageFile; mimeType: string }): Promise<string> {
  const path = soundPath(input, 'source');
  const result = await createAdminClient().storage.from(SOUND_BUCKET).upload(path, input.file, {
    contentType: input.mimeType,
    upsert: false,
  });
  assertSupabaseResult('upload sound source', result);
  return path;
}

/** Replaces only the derived playable object after successful processing. */
export async function replacePlayableClip(input: SoundStorageIdentity & { file: StorageFile; mimeType?: string }): Promise<string> {
  const path = soundPath(input, 'playable');
  const result = await createAdminClient().storage.from(SOUND_BUCKET).upload(path, input.file, {
    contentType: input.mimeType ?? 'audio/wav',
    upsert: true,
  });
  assertSupabaseResult('replace playable sound clip', result);
  return path;
}

/** Removes both internal storage objects belonging to a sound. */
export async function deleteSoundFiles(input: SoundStorageIdentity): Promise<void> {
  const result = await createAdminClient().storage.from(SOUND_BUCKET).remove([
    soundPath(input, 'source'),
    soundPath(input, 'playable'),
  ]);
  assertSupabaseResult('delete sound files', result);
}
