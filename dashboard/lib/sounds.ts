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

export interface SoundMutationLease {
  token: string;
  mutationVersion: number;
}

export type SoundMutationOperation = 'trim' | 'delete';
export type SoundCleanupKind = 'delete_object' | 'discard_stage';

export type SoundMutationRecoveryState =
  | 'trim_uploading'
  | 'trim_uploaded'
  | 'trim_committed'
  | 'delete_staging'
  | 'delete_ready'
  | 'delete_objects_removed'
  | 'delete_committed'
  | 'restore_pending';

export interface SoundMutationRecovery {
  id: string;
  soundId: string | null;
  token: string;
  operation: SoundMutationOperation;
  state: SoundMutationRecoveryState;
  expectedVersion: number;
  sourceStoragePath: string | null;
  playableStoragePath: string | null;
  stagedSourcePath: string | null;
  stagedPlayablePath: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SoundRestoreResult {
  sourceRestored: boolean;
  playableRestored: boolean;
}

export interface SoundCleanupTask {
  id: string;
  soundId: string | null;
  cleanupKind: SoundCleanupKind;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
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

function isManagedSoundPath(path: string): boolean {
  return /^sounds\/[^/\\]+\/[^/\\]+\/(source|playable(?:-[^/\\]+)?|staging\/[^/\\]+\/(source|playable))$/.test(path);
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

/** Acquires a cross-worker lease and captures the row version it protects. */
export async function acquireSoundMutation(input: {
  soundId: string;
  token: string;
  operation: SoundMutationOperation;
}): Promise<SoundMutationLease | null> {
  const result = await createAdminClient().rpc('acquire_sound_mutation', {
    p_sound_id: input.soundId,
    p_token: input.token,
    p_operation: input.operation,
  });
  const value = rpcObject(assertSupabaseResult('acquire sound mutation', result));
  if (!value || value.acquired !== true) return null;
  const mutationVersion = Number(value.mutation_version);
  if (!Number.isSafeInteger(mutationVersion) || mutationVersion < 0) {
    throw new Error('acquire sound mutation: invalid mutation version.');
  }
  return { token: input.token, mutationVersion };
}

/** Releases a lease; expiration remains the crash-recovery fallback. */
export async function releaseSoundMutation(input: { soundId: string; token: string }): Promise<void> {
  assertSupabaseResult(
    'release sound mutation',
    await createAdminClient().rpc('release_sound_mutation', {
      p_sound_id: input.soundId,
      p_token: input.token,
    }),
  );
}

/** Persists the generated trim path before the object upload starts. */
export async function prepareSoundTrimMutation(input: {
  soundId: string;
  lease: SoundMutationLease;
  versionId: string;
  previousPlayablePath: string;
}): Promise<void> {
  const result = await createAdminClient().rpc('prepare_sound_trim_mutation', {
    p_sound_id: input.soundId,
    p_token: input.lease.token,
    p_expected_version: input.lease.mutationVersion,
    p_version_id: input.versionId,
    p_previous_playable_path: input.previousPlayablePath,
  });
  if (!rpcBoolean(assertSupabaseResult('prepare sound trim mutation', result))) {
    throw new Error('Sound trim mutation is no longer current.');
  }
}

/** Advances a server-only recovery record; paths never cross the action boundary. */
export async function markSoundMutationRecovery(input: {
  soundId: string;
  token: string;
  state: SoundMutationRecoveryState;
  lastError?: string;
}): Promise<void> {
  const result = assertSupabaseResult(
    'mark sound mutation recovery',
    await createAdminClient().rpc('mark_sound_mutation_recovery', {
      p_sound_id: input.soundId,
      p_token: input.token,
      p_state: input.state,
      p_last_error: input.lastError ?? null,
    }),
  );
  if (!rpcBoolean(result)) throw new Error('Sound mutation recovery record is unavailable.');
}

/** Removes a recovery record only after all corresponding object cleanup is confirmed. */
export async function completeSoundMutationRecovery(input: { soundId: string; token: string }): Promise<void> {
  const result = assertSupabaseResult(
    'complete sound mutation recovery',
    await createAdminClient().rpc('complete_sound_mutation_recovery', {
      p_sound_id: input.soundId,
      p_token: input.token,
    }),
  );
  if (!rpcBoolean(result)) throw new Error('Sound mutation recovery record could not be completed.');
}

/** Internal reconciliation input; storage paths are intentionally never serialized to clients. */
export async function listPendingSoundMutationRecoveries(): Promise<SoundMutationRecovery[]> {
  const result = await createAdminClient()
    .from('SoundMutationRecovery')
    .select('*')
    .order('updatedAt', { ascending: true });
  const rows = (assertSupabaseResult('list sound mutation recoveries', result) ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    soundId: (row.soundId ?? row.sound_id ?? null) as string | null,
    token: row.token as string,
    operation: row.operation as SoundMutationOperation,
    state: row.state as SoundMutationRecoveryState,
    expectedVersion: Number(row.expectedVersion ?? row.expected_version),
    sourceStoragePath: (row.sourceStoragePath ?? row.source_storage_path ?? null) as string | null,
    playableStoragePath: (row.playableStoragePath ?? row.playable_storage_path ?? null) as string | null,
    stagedSourcePath: (row.stagedSourcePath ?? row.staged_source_path ?? null) as string | null,
    stagedPlayablePath: (row.stagedPlayablePath ?? row.staged_playable_path ?? null) as string | null,
    lastError: (row.lastError ?? row.last_error ?? null) as string | null,
    createdAt: (row.createdAt ?? row.created_at) as string,
    updatedAt: (row.updatedAt ?? row.updated_at) as string,
  }));
}

/** Commits a trim only if this worker still owns the lease and row version. */
export async function commitSoundTrim(input: {
  soundId: string;
  lease: SoundMutationLease;
  storagePath: string;
  trimStartMs: number;
  trimEndMs: number;
  durationSec: number;
}): Promise<SoundRecord | null> {
  const result = await createAdminClient().rpc('commit_sound_trim', {
    p_sound_id: input.soundId,
    p_token: input.lease.token,
    p_expected_version: input.lease.mutationVersion,
    p_storage_path: input.storagePath,
    p_trim_start_ms: input.trimStartMs,
    p_trim_end_ms: input.trimEndMs,
    p_duration_sec: input.durationSec,
  });
  const value = assertSupabaseResult('commit sound trim', result);
  const row = rpcObject(value);
  return row ? mapSoundRow(row) : null;
}

/** Deletes a row only if this worker still owns the lease and row version. */
export async function commitSoundDelete(input: {
  soundId: string;
  lease: SoundMutationLease;
}): Promise<boolean> {
  return rpcBoolean(assertSupabaseResult(
    'commit sound delete',
    await createAdminClient().rpc('delete_sound_row_if_mutation', {
      p_sound_id: input.soundId,
      p_token: input.lease.token,
      p_expected_version: input.lease.mutationVersion,
    }),
  ));
}

/** Records a server-only cleanup task without returning its storage path. */
export async function enqueueSoundCleanupTask(input: {
  soundId: string | null;
  objectPath: string;
  cleanupKind: SoundCleanupKind;
}): Promise<void> {
  if (!isManagedSoundPath(input.objectPath)) throw new Error('Sound cleanup path is invalid.');
  assertSupabaseResult(
    'enqueue sound cleanup',
    await createAdminClient().rpc('enqueue_sound_cleanup', {
      p_sound_id: input.soundId,
      p_object_path: input.objectPath,
      p_cleanup_kind: input.cleanupKind,
    }),
  );
}

/** Lists cleanup work for an internal worker; object paths stay server-side. */
export async function listPendingSoundCleanupTasks(limit = 100): Promise<SoundCleanupTask[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const result = await createAdminClient()
    .from('SoundCleanupTask')
    .select('id,soundId,cleanupKind,attempts,nextAttemptAt,lastError,createdAt')
    .order('nextAttemptAt', { ascending: true })
    .limit(boundedLimit);
  const rows = (assertSupabaseResult('list sound cleanup tasks', result) ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    soundId: (row.soundId ?? row.sound_id ?? null) as string | null,
    cleanupKind: (row.cleanupKind ?? row.cleanup_kind) as SoundCleanupKind,
    attempts: Number(row.attempts),
    nextAttemptAt: (row.nextAttemptAt ?? row.next_attempt_at) as string,
    lastError: (row.lastError ?? row.last_error ?? null) as string | null,
    createdAt: (row.createdAt ?? row.created_at) as string,
  }));
}

/** Attempts one queued object cleanup while keeping provider details server-only. */
export async function retrySoundCleanupTask(taskId: string): Promise<boolean> {
  const client = createAdminClient();
  const lookup = await client.from('SoundCleanupTask').select('id,soundId,objectPath,attempts').eq('id', taskId).maybeSingle();
  const task = assertSupabaseResult('load sound cleanup task', lookup) as { id: string; soundId: string | null; objectPath: string; attempts: number } | null;
  if (!task) return false;
  try {
    await deleteStorageObject(task.objectPath);
    await finalizeRecoveryAfterCleanup(client, task.objectPath, task.soundId);
    assertSupabaseResult('remove completed sound cleanup task', await client.from('SoundCleanupTask').delete().eq('id', task.id));
    return true;
  } catch {
    await client.from('SoundCleanupTask').update({
      attempts: Number(task.attempts || 0) + 1,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      lastError: 'Storage cleanup attempt failed.',
    }).eq('id', task.id);
    return false;
  }
}

async function finalizeRecoveryAfterCleanup(
  client: ReturnType<typeof createAdminClient>,
  objectPath: string,
  soundId: string | null,
): Promise<void> {
  if (!soundId) return;
  const result = await client
    .from('SoundMutationRecovery')
    .select('id,token,state,playableStoragePath,stagedSourcePath,stagedPlayablePath')
    .eq('soundId', soundId);
  const recoveries = (assertSupabaseResult('load sound recovery after cleanup', result) ?? []) as Array<Record<string, unknown>>;
  for (const recovery of recoveries) {
    const state = recovery.state as SoundMutationRecoveryState;
    if (state === 'trim_committed' && recovery.playableStoragePath === objectPath) {
      assertSupabaseResult(
        'complete trimmed sound recovery',
        await client.from('SoundMutationRecovery').delete().eq('id', recovery.id),
      );
      continue;
    }
    if (state !== 'delete_committed') continue;
    const stagedSourcePath = recovery.stagedSourcePath as string | null;
    const stagedPlayablePath = recovery.stagedPlayablePath as string | null;
    if (objectPath !== stagedSourcePath && objectPath !== stagedPlayablePath) continue;
    const storage = client.storage.from(SOUND_BUCKET);
    const [sourceResult, playableResult] = await Promise.all([
      stagedSourcePath ? storage.download(stagedSourcePath) : Promise.resolve({ data: null, error: null }),
      stagedPlayablePath ? storage.download(stagedPlayablePath) : Promise.resolve({ data: null, error: null }),
    ]);
    if (!sourceResult.error && sourceResult.data || !playableResult.error && playableResult.data) continue;
    assertSupabaseResult(
      'complete deleted sound recovery',
      await client.from('SoundMutationRecovery').delete().eq('id', recovery.id),
    );
  }
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
  if (!isManagedSoundPath(path)) throw new Error('Sound storage path is invalid.');
  assertSupabaseResult('delete sound storage object', await createAdminClient().storage.from(SOUND_BUCKET).remove([path]));
}

/** Copies both live objects to private staging paths before a destructive delete begins. */
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
    p_source_path: sourceStoragePath,
    p_playable_path: playableStoragePath,
    p_staged_source_path: staged.source,
    p_staged_playable_path: staged.playable,
  });
  if (!rpcBoolean(assertSupabaseResult('prepare sound delete mutation', prepared))) {
    throw new Error('Sound delete mutation is no longer current.');
  }

  try {
    assertSupabaseResult('stage sound source', await storage.copy(sourceStoragePath, staged.source));
    assertSupabaseResult('stage playable sound', await storage.copy(playableStoragePath, staged.playable));
    const marked = assertSupabaseResult(
      'mark sound deletion staged',
      await createAdminClient().rpc('mark_sound_mutation_recovery', {
        p_sound_id: input.sound.id,
        p_token: input.lease.token,
        p_state: 'delete_ready',
        p_last_error: null,
      }),
    );
    if (!rpcBoolean(marked)) throw new Error('Sound deletion staging record is unavailable.');
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
export async function restoreSoundFiles(stage: SoundFileDeletionStage): Promise<SoundRestoreResult> {
  const storage = createAdminClient().storage.from(SOUND_BUCKET);
  let source: Blob | null = null;
  let playable: Blob | null = null;
  try {
    source = assertSupabaseResult(
      'download staged sound source',
      await storage.download(stage.stagedSourcePath),
    );
  } catch {
    source = null;
  }
  try {
    playable = assertSupabaseResult(
      'download staged playable sound',
      await storage.download(stage.stagedPlayablePath),
    );
  } catch {
    playable = null;
  }

  let sourceRestored = false;
  let playableRestored = false;
  if (source) {
    try {
      await uploadWithCompensationRetries(stage.sourceStoragePath, source, stage.sourceMimeType);
      sourceRestored = true;
    } catch {
      sourceRestored = false;
    }
  }
  if (playable) {
    try {
      await uploadWithCompensationRetries(stage.playableStoragePath, playable, 'audio/wav');
      playableRestored = true;
    } catch {
      playableRestored = false;
    }
  }
  return { sourceRestored, playableRestored };
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
