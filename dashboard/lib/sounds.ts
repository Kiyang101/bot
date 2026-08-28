import 'server-only';
import { assertSupabaseResult } from './database';
import { mapSoundRow as mapValidatedSoundRow } from './sound-validation';
import type { SoundRecord } from './sound-types';
import { createAdminClient } from './supabase/admin';

const SOUND_BUCKET = 'sounds';
const SIGNED_URL_TTL_SECONDS = 60 * 5;

type StorageFile = Blob | ArrayBuffer | Uint8Array;
type SoundStorageIdentity = { uploadedById: string; soundId: string };

export interface SoundFileDeletionStage {
  sourceStoragePath: string;
  playableStoragePath: string;
  stagedSourcePath: string;
  stagedPlayablePath: string;
  sourceMimeType: string;
}

export type NewSoundRecord = Omit<SoundRecord, 'createdAt' | 'updatedAt'>;
export type SoundRecordUpdate = Partial<
  Pick<
    SoundRecord,
    | 'name'
    | 'category'
    | 'color'
    | 'shortcut'
    | 'gainDb'
    | 'fadeInMs'
    | 'fadeOutMs'
    | 'storagePath'
    | 'trimStartMs'
    | 'trimEndMs'
    | 'durationSec'
    | 'sortOrder'
  >
>;

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
  return /^sounds\/[^/\\]+\/[^/\\]+\/(source|playable(?:-[^/\\]+)?)$/.test(path);
}

function playablePath(identity: SoundStorageIdentity, versionId: string): string {
  return `${soundPath(identity, 'playable')}-${requireStorageIdentifier(versionId, 'Playable version id')}`;
}

function deletionStagePaths(identity: SoundStorageIdentity, stageId: string) {
  const prefix = `sounds/${requireStorageIdentifier(identity.uploadedById, 'Uploader id')}/${requireStorageIdentifier(identity.soundId, 'Sound id')}/staging/${requireStorageIdentifier(stageId, 'Stage id')}`;
  return { source: `${prefix}/source`, playable: `${prefix}/playable` };
}

function requireRecordStoragePath(path: string, identity: SoundStorageIdentity, object: 'source' | 'playable'): string {
  const expectedSource = soundPath(identity, 'source');
  const expectedPlayablePrefix = `${soundPath(identity, 'playable')}-`;
  if (
    (object === 'source' && path !== expectedSource)
    || (object === 'playable' && path !== soundPath(identity, 'playable') && !path.startsWith(expectedPlayablePrefix))
  ) {
    throw new Error('Sound storage path is invalid.');
  }
  return path;
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

/** Inserts a fully prepared global Sound row and returns the validated record. */
export async function insertSound(input: NewSoundRecord): Promise<SoundRecord> {
  const result = await createAdminClient().from('Sound').insert(input).select('*').single();
  const row = assertSupabaseResult('insert sound', result);
  return mapSoundRow(row);
}

/** Updates trusted metadata for one global Sound record. */
export async function updateSound(id: string, input: SoundRecordUpdate): Promise<SoundRecord> {
  const result = await createAdminClient()
    .from('Sound')
    .update({ ...input, updatedAt: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  const row = assertSupabaseResult('update sound', result);
  return mapSoundRow(row);
}

/** Deletes one global Sound row after its paired storage objects have been removed. */
export async function deleteSoundRow(id: string): Promise<void> {
  assertSupabaseResult('delete sound row', await createAdminClient().from('Sound').delete().eq('id', id));
}

/** Persists the complete global order in one database transaction. */
export async function updateSoundOrder(soundIds: string[]): Promise<void> {
  assertSupabaseResult(
    'update sound order',
    await createAdminClient().rpc('reorder_sounds', { sound_ids: soundIds }),
  );
}

/** Creates a short-lived URL for an internal Sound storage object. */
export async function getSignedSoundUrl(path: string): Promise<string> {
  if (!isSoundPath(path)) throw new Error('Sound storage path is invalid.');
  const client = createAdminClient();
  let sound = assertSupabaseResult(
    'look up sound storage path',
    await client
      .from('Sound')
      .select('id')
      .eq('storagePath', path)
      .maybeSingle(),
  );
  if (!sound) {
    sound = assertSupabaseResult(
      'look up sound source storage path',
      await client.from('Sound').select('id').eq('sourceStoragePath', path).maybeSingle(),
    );
  }
  if (!sound) throw new Error('Sound storage path is not registered.');
  const result = await client.storage.from(SOUND_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
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

/** Uploads a new immutable derived clip; the row is switched to it only after this succeeds. */
export async function uploadPlayableClip(input: SoundStorageIdentity & { file: StorageFile; mimeType?: string; versionId: string }): Promise<string> {
  const path = playablePath(input, input.versionId);
  const result = await createAdminClient().storage.from(SOUND_BUCKET).upload(path, input.file, {
    contentType: input.mimeType ?? 'audio/wav',
    upsert: false,
  });
  assertSupabaseResult('upload playable sound clip', result);
  return path;
}

/** Downloads a retained source using only the fixed, server-controlled object path. */
export async function downloadSource(input: SoundStorageIdentity): Promise<Blob> {
  const result = await createAdminClient().storage.from(SOUND_BUCKET).download(soundPath(input, 'source'));
  const source = assertSupabaseResult('download sound source', result);
  if (!source) throw new Error('Sound source file is unavailable.');
  return source;
}

/** Removes one trusted registered object, normally an uncommitted or superseded playable clip. */
export async function deleteStorageObject(path: string): Promise<void> {
  if (!isSoundPath(path)) throw new Error('Sound storage path is invalid.');
  assertSupabaseResult('delete sound storage object', await createAdminClient().storage.from(SOUND_BUCKET).remove([path]));
}

/** Copies both live objects to private staging paths before a destructive delete begins. */
export async function stageSoundFilesForDeletion(input: {
  sound: Pick<SoundRecord, 'id' | 'uploadedById' | 'sourceStoragePath' | 'storagePath' | 'mimeType'>;
  stageId: string;
}): Promise<SoundFileDeletionStage> {
  const identity = { uploadedById: input.sound.uploadedById, soundId: input.sound.id };
  const sourceStoragePath = requireRecordStoragePath(input.sound.sourceStoragePath, identity, 'source');
  const playableStoragePath = requireRecordStoragePath(input.sound.storagePath, identity, 'playable');
  const staged = deletionStagePaths(identity, input.stageId);
  const storage = createAdminClient().storage.from(SOUND_BUCKET);

  try {
    assertSupabaseResult('stage sound source', await storage.copy(sourceStoragePath, staged.source));
    assertSupabaseResult('stage playable sound', await storage.copy(playableStoragePath, staged.playable));
  } catch (error) {
    await storage.remove([staged.source, staged.playable]).catch(() => undefined);
    throw error;
  }

  return {
    sourceStoragePath,
    playableStoragePath,
    stagedSourcePath: staged.source,
    stagedPlayablePath: staged.playable,
    sourceMimeType: input.sound.mimeType,
  };
}

/** Removes both live objects only after recoverable staging has completed. */
export async function deleteSoundFiles(stage: SoundFileDeletionStage): Promise<void> {
  const result = await createAdminClient().storage.from(SOUND_BUCKET).remove([
    stage.sourceStoragePath,
    stage.playableStoragePath,
  ]);
  assertSupabaseResult('delete sound files', result);
}

async function uploadWithCompensationRetries(path: string, file: Blob, mimeType: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await createAdminClient().storage.from(SOUND_BUCKET).upload(path, file, {
      contentType: mimeType,
      upsert: true,
    });
    if (!result.error) return;
    lastError = result.error;
  }
  throw lastError instanceof Error ? lastError : new Error('Sound storage recovery failed.');
}

/** Restores both live objects from staging when storage or row deletion fails. */
export async function restoreSoundFiles(stage: SoundFileDeletionStage): Promise<void> {
  const storage = createAdminClient().storage.from(SOUND_BUCKET);
  const [sourceResult, playableResult] = await Promise.all([
    storage.download(stage.stagedSourcePath),
    storage.download(stage.stagedPlayablePath),
  ]);
  const source = assertSupabaseResult('download staged sound source', sourceResult);
  const playable = assertSupabaseResult('download staged playable sound', playableResult);
  if (!source || !playable) throw new Error('Sound storage recovery failed.');
  await Promise.all([
    uploadWithCompensationRetries(stage.sourceStoragePath, source, stage.sourceMimeType),
    uploadWithCompensationRetries(stage.playableStoragePath, playable, 'audio/wav'),
  ]);
}

/** Removes private recovery copies after the delete either commits or rolls back. */
export async function discardSoundFileStage(stage: SoundFileDeletionStage): Promise<void> {
  assertSupabaseResult(
    'discard staged sound files',
    await createAdminClient().storage.from(SOUND_BUCKET).remove([
      stage.stagedSourcePath,
      stage.stagedPlayablePath,
    ]),
  );
}
