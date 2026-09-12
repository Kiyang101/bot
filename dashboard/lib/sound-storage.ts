import 'server-only';
import { assertSupabaseResult } from './database';
import { createAdminClient } from './supabase/admin';
import type {
  SoundFileDeletionStage,
  SoundMutationLease,
  SoundRestoreResult,
} from './sounds';
import type { SoundRecord } from './sound-types';

const SOUND_BUCKET = 'sounds';
const SIGNED_URL_TTL_SECONDS = 60 * 5;

type StorageFile = Blob | ArrayBuffer | Uint8Array;
export type SoundStorageIdentity = { uploadedById: string; soundId: string };

export class SoundDeletionStagingError extends Error {
  readonly recoveryRequired = true;

  constructor() {
    super('Sound deletion staging requires server recovery.');
    this.name = 'SoundDeletionStagingError';
  }
}

function requireStorageIdentifier(value: string, label: string): string {
  if (!value || value.includes('/') || value.includes('\\')) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function soundPath({ uploadedById, soundId }: SoundStorageIdentity, object: 'source' | 'playable'): string {
  return `sounds/${requireStorageIdentifier(uploadedById, 'Uploader id')}/${requireStorageIdentifier(soundId, 'Sound id')}/${object}`;
}

export function isSoundPath(path: string): boolean {
  return /^sounds\/[^/\\]+\/[^/\\]+\/(source|playable(?:-[^/\\]+)?)$/.test(path);
}

export function isManagedSoundPath(path: string): boolean {
  return /^sounds\/[^/\\]+\/[^/\\]+\/(source|playable(?:-[^/\\]+)?|staging\/[^/\\]+\/(source|playable))$/.test(path);
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

function rpcObject(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return rpcObject(data[0]);
  return data && typeof data === 'object' ? data as Record<string, unknown> : null;
}

function rpcBoolean(data: unknown): boolean {
  if (typeof data === 'boolean') return data;
  const object = rpcObject(data);
  return object?.value === true || object?.deleted === true;
}

/** Creates a short-lived URL for an internal Sound storage object. */
export async function getSignedSoundUrl(path: string): Promise<string> {
  if (!isSoundPath(path)) throw new Error('Sound storage path is invalid.');
  const client = createAdminClient();
  let sound = assertSupabaseResult(
    'look up sound storage path',
    await client.from('Sound').select('id').eq('storagePath', path).maybeSingle(),
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

export async function uploadSource(input: SoundStorageIdentity & { file: StorageFile; mimeType: string }): Promise<string> {
  const path = soundPath(input, 'source');
  assertSupabaseResult('upload sound source', await createAdminClient().storage.from(SOUND_BUCKET).upload(path, input.file, {
    contentType: input.mimeType,
    upsert: false,
  }));
  return path;
}

export async function uploadPlayableClip(input: SoundStorageIdentity & { file: StorageFile; mimeType?: string; versionId: string }): Promise<string> {
  const path = playablePath(input, input.versionId);
  assertSupabaseResult('upload playable sound clip', await createAdminClient().storage.from(SOUND_BUCKET).upload(path, input.file, {
    contentType: input.mimeType ?? 'audio/wav',
    upsert: false,
  }));
  return path;
}

export async function downloadSource(input: SoundStorageIdentity): Promise<Blob> {
  const source = assertSupabaseResult('download sound source', await createAdminClient().storage.from(SOUND_BUCKET).download(soundPath(input, 'source')));
  if (!source) throw new Error('Sound source file is unavailable.');
  return source;
}

export async function deleteStorageObject(path: string): Promise<void> {
  if (!isManagedSoundPath(path)) throw new Error('Sound storage path is invalid.');
  assertSupabaseResult('delete sound storage object', await createAdminClient().storage.from(SOUND_BUCKET).remove([path]));
}

export async function stageSoundFilesForDeletion(input: {
  sound: Pick<SoundRecord, 'id' | 'uploadedById' | 'sourceStoragePath' | 'storagePath' | 'mimeType'>;
  stageId: string;
  lease: SoundMutationLease;
}): Promise<SoundFileDeletionStage> {
  const identity = { uploadedById: input.sound.uploadedById, soundId: input.sound.id };
  const sourceStoragePath = requireRecordStoragePath(input.sound.sourceStoragePath, identity, 'source');
  const playableStoragePath = requireRecordStoragePath(input.sound.storagePath, identity, 'playable');
  const staged = deletionStagePaths(identity, input.stageId);
  const storage = createAdminClient().storage.from(SOUND_BUCKET);
  const prepared = await createAdminClient().rpc('prepare_sound_delete_mutation', {
    p_sound_id: input.sound.id,
    p_token: input.lease.token,
    p_expected_version: input.lease.mutationVersion,
    p_stage_id: input.stageId,
  });
  if (!rpcBoolean(assertSupabaseResult('prepare sound delete mutation', prepared))) {
    throw new Error('Sound delete mutation is no longer current.');
  }
  try {
    assertSupabaseResult('stage sound source', await storage.copy(sourceStoragePath, staged.source));
    assertSupabaseResult('stage playable sound', await storage.copy(playableStoragePath, staged.playable));
    const marked = assertSupabaseResult('mark sound deletion staged', await createAdminClient().rpc('mark_sound_mutation_recovery', {
      p_sound_id: input.sound.id,
      p_token: input.lease.token,
      p_operation: 'delete',
      p_state: 'delete_ready',
      p_last_error: null,
    }));
    if (!rpcBoolean(marked)) {
      throw new Error('Sound deletion staging record is unavailable.');
    }
  } catch {
    try {
      await createAdminClient().rpc('mark_sound_mutation_recovery', {
        p_sound_id: input.sound.id,
        p_token: input.lease.token,
        p_operation: 'delete',
        p_state: 'delete_staging',
        p_last_error: 'Delete staging was interrupted; server recovery is required.',
      });
    } catch { /* The prepared ledger row remains authoritative. */ }
    throw new SoundDeletionStagingError();
  }
  return { sourceStoragePath, playableStoragePath, stagedSourcePath: staged.source, stagedPlayablePath: staged.playable, sourceMimeType: input.sound.mimeType };
}

export async function deleteSoundFiles(stage: SoundFileDeletionStage): Promise<void> {
  assertSupabaseResult('delete sound files', await createAdminClient().storage.from(SOUND_BUCKET).remove([stage.sourceStoragePath, stage.playableStoragePath]));
}

export async function uploadWithCompensationRetries(path: string, file: Blob, mimeType: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await createAdminClient().storage.from(SOUND_BUCKET).upload(path, file, { contentType: mimeType, upsert: true });
    if (!result.error) return;
    lastError = result.error;
  }
  throw lastError instanceof Error ? lastError : new Error('Sound storage recovery failed.');
}

export async function restoreSoundFiles(stage: SoundFileDeletionStage): Promise<SoundRestoreResult> {
  const storage = createAdminClient().storage.from(SOUND_BUCKET);
  let source: Blob | null = null;
  let playable: Blob | null = null;
  try { source = assertSupabaseResult('download staged sound source', await storage.download(stage.stagedSourcePath)); } catch { source = null; }
  try { playable = assertSupabaseResult('download staged playable sound', await storage.download(stage.stagedPlayablePath)); } catch { playable = null; }
  let sourceRestored = false;
  let playableRestored = false;
  if (source) { try { await uploadWithCompensationRetries(stage.sourceStoragePath, source, stage.sourceMimeType); sourceRestored = true; } catch { sourceRestored = false; } }
  if (playable) { try { await uploadWithCompensationRetries(stage.playableStoragePath, playable, 'audio/wav'); playableRestored = true; } catch { playableRestored = false; } }
  return { sourceRestored, playableRestored };
}

export async function discardSoundFileStage(stage: SoundFileDeletionStage): Promise<void> {
  assertSupabaseResult('discard staged sound files', await createAdminClient().storage.from(SOUND_BUCKET).remove([stage.stagedSourcePath, stage.stagedPlayablePath]));
}
