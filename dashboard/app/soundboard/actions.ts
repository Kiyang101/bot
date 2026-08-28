import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../../lib/auth';
import {
  MAX_FADE_MS,
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  canEditSound,
  isPresetSoundColor,
  isSharedSoundCategory,
  normalizeShortcut,
  validateTrimRange,
  validateUploadMeta,
} from '../../lib/sound-validation';
import type { SoundMutationResult, SoundRecord } from '../../lib/sound-types';
import type {
  NewSoundRecord,
  SoundCleanupKind,
  SoundFileDeletionStage,
  SoundMutationLease,
  SoundMutationOperation,
  SoundMutationRecoveryState,
  SoundRestoreResult,
  SoundRecordUpdate,
} from '../../lib/sounds';
import { SoundboardBusyError, type SoundboardPlayPayload } from '../../lib/control';
import { detectSupportedAudioMimeType } from '../../lib/audio';

export type SoundboardSound = Omit<SoundRecord, 'storagePath' | 'sourceStoragePath'>;
export type SoundboardActionResult<T = undefined> =
  | { ok: true; value?: T; warning?: string; recoveryRequired?: boolean }
  | { ok: false; message: string; warning?: string; recoveryRequired?: boolean };

export interface SoundboardData {
  user: Pick<SessionUser, 'id' | 'username' | 'role'>;
  selectedGuildId: string | null;
  sounds: SoundboardSound[];
}

export interface SoundMetadataInput {
  name: string;
  category: string;
  color: string;
  shortcut: string | null;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}

type ValidSoundMetadata = Required<
  Pick<SoundRecord, 'name' | 'category' | 'color' | 'shortcut' | 'gainDb' | 'fadeInMs' | 'fadeOutMs'>
>;

export interface UploadSoundInput extends SoundMetadataInput {
  file: Pick<File, 'arrayBuffer' | 'size' | 'type'>;
  trimStartMs: number;
  trimEndMs: number;
}

export interface TrimSoundInput {
  soundId: string;
  trimStartMs: number;
  trimEndMs: number;
}

export interface PlaySoundInput {
  soundId: string;
  channelId: string;
}

export interface SoundboardActionDependencies {
  getSessionUser: () => Promise<SessionUser | null>;
  getSelectedGuildId: () => Promise<string | null>;
  getAuthorizedGuildIds: (discordUserId: string) => Promise<readonly string[]>;
  canMemberUseVoiceChannel: (guildId: string, channelId: string, discordUserId: string) => Promise<boolean>;
  listSounds: () => Promise<SoundRecord[]>;
  getSound: (id: string) => Promise<SoundRecord | null>;
  getSignedSoundUrl: (path: string) => Promise<string>;
  uploadSource: (input: { uploadedById: string; soundId: string; file: ArrayBuffer; mimeType: string }) => Promise<string>;
  uploadPlayableClip: (input: { uploadedById: string; soundId: string; file: Uint8Array; mimeType?: string; versionId: string }) => Promise<string>;
  prepareSoundUploadRecovery: (input: {
    soundId: string;
    uploadedById: string;
    sourceStoragePath: string;
    playableStoragePath: string;
  }) => Promise<{ token: string }>;
  heartbeatSoundUploadRecovery: (input: { soundId: string; token: string }) => Promise<void>;
  markSoundUploadRecoveryPending: (input: { soundId: string; token: string; lastError: string }) => Promise<void>;
  completeSoundUploadRecovery: (input: {
    soundId: string;
    token: string;
    sourceStoragePath: string;
    playableStoragePath: string;
    outcome: 'row_committed' | 'objects_absent';
  }) => Promise<void>;
  confirmStorageObjectAbsent: (path: string) => Promise<boolean>;
  deleteStorageObject: (path: string) => Promise<void>;
  downloadSource: (input: { uploadedById: string; soundId: string }) => Promise<Blob>;
  stageSoundFilesForDeletion: (input: {
    sound: Pick<SoundRecord, 'id' | 'uploadedById' | 'sourceStoragePath' | 'storagePath' | 'mimeType'>;
    stageId: string;
    lease: SoundMutationLease;
  }) => Promise<SoundFileDeletionStage>;
  deleteSoundFiles: (stage: SoundFileDeletionStage) => Promise<void>;
  restoreSoundFiles: (stage: SoundFileDeletionStage) => Promise<SoundRestoreResult | void>;
  discardSoundFileStage: (stage: SoundFileDeletionStage) => Promise<void>;
  insertSound: (input: NewSoundRecord) => Promise<SoundRecord>;
  updateSound: (id: string, input: SoundRecordUpdate) => Promise<SoundRecord>;
  deleteSoundRow: (id: string) => Promise<void>;
  acquireSoundMutation: (soundId: string, operation: SoundMutationOperation, token: string) => Promise<SoundMutationLease | null>;
  releaseSoundMutation: (soundId: string, token: string) => Promise<void>;
  prepareSoundTrimMutation: (input: {
    soundId: string;
    lease: SoundMutationLease;
    versionId: string;
    previousPlayablePath: string;
    sourceStoragePath: string;
    generatedStoragePath: string;
    trimStartMs: number;
    trimEndMs: number;
    sourceDurationSec: number;
    generatedDurationSec: number;
    sourceMimeType: string;
    generatedMimeType: string;
    sourceSizeBytes: number;
    generatedSizeBytes: number;
  }) => Promise<void>;
  markSoundMutationRecovery: (input: {
    soundId: string;
    token: string;
    operation: SoundMutationOperation;
    state: SoundMutationRecoveryState;
    lastError?: string;
  }) => Promise<void>;
  completeSoundMutationRecovery: (input: { soundId: string; token: string; operation: SoundMutationOperation }) => Promise<void>;
  commitSoundTrim: (input: {
    soundId: string;
    lease: SoundMutationLease;
    storagePath: string;
    trimStartMs: number;
    trimEndMs: number;
    durationSec: number;
  }) => Promise<SoundRecord | null>;
  commitSoundDelete: (input: { soundId: string; lease: SoundMutationLease }) => Promise<boolean>;
  enqueueSoundCleanup: (input: { soundId: string | null; objectPath: string; cleanupKind: SoundCleanupKind }) => Promise<void>;
  reconcileSoundMutationRecoveries: () => Promise<{ processed: number; deferred: number }>;
  updateSoundOrder: (soundIds: string[]) => Promise<void>;
  trimSourceFile: (input: {
    source: Buffer | Uint8Array;
    mimeType: string;
    trimStartMs: number;
    trimEndMs: number;
  }) => Promise<{ buffer: Buffer; durationSec: number; sourceDurationSec: number }>;
  sendSoundboardPlay: (payload: SoundboardPlayPayload) => Promise<void>;
  sendSoundboardStop: (guildId: string, channelId: string) => Promise<void>;
  revalidatePath: (path: string) => void;
  createSoundId: () => string;
}

function asClientSound(sound: SoundRecord): SoundboardSound {
  const { storagePath: _storagePath, sourceStoragePath: _sourceStoragePath, ...clientSound } = sound;
  return clientSound;
}

const PUBLIC_PROCESSING_MESSAGES = new Set([
  'Audio processing is unavailable on this dashboard host.',
  'The uploaded audio file could not be processed.',
  'Sound must be an MP3, WAV, or OGG file.',
  'Trim values must be finite numbers.',
  'Trim range must fit inside the source duration.',
  'Sound clips must be at least 100 ms long.',
]);
const CLEANUP_RETRY_ATTEMPTS = 3;
const CLEANUP_WARNING = 'Audio cleanup could not be completed. Please retry or contact an administrator.';
const DELETE_CLEANUP_WARNING = 'Sound deleted, but temporary cleanup could not be completed. An administrator can retry cleanup.';
const soundMutationLocks = new Map<string, Promise<void>>();

function actionError(error: unknown, fallback: string): SoundMutationResult {
  if (error instanceof SoundboardBusyError) return { ok: false, message: error.message };
  if (error instanceof Error && PUBLIC_PROCESSING_MESSAGES.has(error.message)) {
    return { ok: false, message: error.message };
  }
  return { ok: false, message: fallback };
}

async function retryCleanup(cleanup: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; attempt < CLEANUP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await cleanup();
      return true;
    } catch {
      // Return a sanitized warning after bounded retries; provider details stay server-side.
    }
  }
  return false;
}

interface CleanupOutcome {
  cleaned: boolean;
  recoveryRequired: boolean;
}

async function cleanupWithRecovery(
  dependencies: SoundboardActionDependencies,
  input: { soundId: string | null; objectPath: string; cleanupKind: SoundCleanupKind },
  cleanup: () => Promise<void>,
): Promise<CleanupOutcome> {
  if (await retryCleanup(cleanup) && await dependencies.confirmStorageObjectAbsent(input.objectPath)) {
    return { cleaned: true, recoveryRequired: false };
  }
  try {
    await dependencies.enqueueSoundCleanup(input);
    return { cleaned: false, recoveryRequired: false };
  } catch {
    // Keep the object/recovery ledger entry in place and make the unavailable
    // outbox actionable without exposing provider details to the client.
    return { cleaned: false, recoveryRequired: true };
  }
}

async function enqueueDurableCleanup(
  dependencies: SoundboardActionDependencies,
  input: { soundId: string | null; objectPath: string; cleanupKind: SoundCleanupKind },
): Promise<boolean> {
  try {
    await dependencies.enqueueSoundCleanup(input);
    return true;
  } catch {
    return false;
  }
}

function addWarning<T>(result: SoundboardActionResult<T>, warning: string | null): SoundboardActionResult<T> {
  return warning ? { ...result, warning } : result;
}

function addRecoveryRequired<T>(
  result: SoundboardActionResult<T>,
  recoveryRequired: boolean,
): SoundboardActionResult<T> {
  return recoveryRequired ? { ...result, recoveryRequired: true } : result;
}

async function withSoundMutationLock<T>(soundId: string, work: () => Promise<T>): Promise<T> {
  const previous = soundMutationLocks.get(soundId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  soundMutationLocks.set(soundId, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (soundMutationLocks.get(soundId) === current) soundMutationLocks.delete(soundId);
  }
}

async function withDurableSoundMutation<T>(
  dependencies: SoundboardActionDependencies,
  soundId: string,
  operation: SoundMutationOperation,
  work: (lease: SoundMutationLease) => Promise<T>,
): Promise<T | SoundboardActionResult> {
  // Give expired records a bounded chance to finish before acquiring a new
  // lease. The database CAS remains the final authority for every mutation.
  await dependencies.reconcileSoundMutationRecoveries().catch(() => undefined);
  const token = dependencies.createSoundId();
  let lease: SoundMutationLease | null = null;
  try {
    lease = await dependencies.acquireSoundMutation(soundId, operation, token);
  } catch {
    return { ok: false, message: 'Sound mutation coordination is unavailable. Please retry.' };
  }
  if (!lease) return { ok: false, message: 'Sound is being updated. Please retry.' };

  try {
    return await work(lease);
  } finally {
    try {
      await dependencies.releaseSoundMutation(soundId, lease.token);
    } catch {
      // The lease expires automatically if release is unavailable.
    }
  }
}

async function requireUser(dependencies: SoundboardActionDependencies): Promise<SessionUser | null> {
  return dependencies.getSessionUser();
}

function revalidateSoundboard(dependencies: SoundboardActionDependencies): void {
  try {
    dependencies.revalidatePath('/soundboard');
    dependencies.revalidatePath('/soundboard/manage');
  } catch {
    // The mutation already committed; cache invalidation must not turn it into a reported failure.
  }
}

function validChannelId(channelId: unknown): string | null {
  const value = typeof channelId === 'string' ? channelId.trim() : '';
  return value || null;
}

function validSoundId(soundId: unknown): string | null {
  const value = typeof soundId === 'string' ? soundId.trim() : '';
  return value || null;
}

function validateMetadata(
  input: Partial<SoundMetadataInput> | null | undefined,
  allowCustomCategory: boolean,
  retainedCustomCategory: string | null = null,
): SoundMutationResult<ValidSoundMetadata> {
  const name = typeof input?.name === 'string' ? input.name : '';
  const nameResult = validateUploadMeta(name, 'audio/wav', 0);
  if (!nameResult.ok) return nameResult;

  const category = typeof input?.category === 'string' ? input.category.trim() : '';
  if (!category || category.length > 40) return { ok: false, message: 'Category must be between 1 and 40 characters.' };
  if (!allowCustomCategory && !isSharedSoundCategory(category) && category !== retainedCustomCategory) {
    return {
      ok: false,
      message: retainedCustomCategory
        ? 'Members may only use the shared sound categories or retain the existing custom category.'
        : 'Members may only use the shared sound categories.',
    };
  }

  const color = typeof input?.color === 'string' ? input.color.trim() : '';
  if (!isPresetSoundColor(color)) return { ok: false, message: 'Choose one of the preset sound colors.' };

  const shortcutInput = input?.shortcut ?? '';
  if (typeof shortcutInput !== 'string') return { ok: false, message: 'Shortcut is invalid.' };
  const shortcut = shortcutInput ? normalizeShortcut(shortcutInput) : null;
  if (shortcutInput && !shortcut) return { ok: false, message: 'Shortcut must be one printable key.' };

  const gainDb = input?.gainDb;
  if (typeof gainDb !== 'number' || !Number.isFinite(gainDb) || gainDb < MIN_GAIN_DB || gainDb > MAX_GAIN_DB) {
    return { ok: false, message: `Gain must be between ${MIN_GAIN_DB} and ${MAX_GAIN_DB} dB.` };
  }
  const fadeInMs = input?.fadeInMs;
  if (typeof fadeInMs !== 'number' || !Number.isInteger(fadeInMs) || fadeInMs < 0 || fadeInMs > MAX_FADE_MS) {
    return { ok: false, message: `Fade-in must be between 0 and ${MAX_FADE_MS} ms.` };
  }
  const fadeOutMs = input?.fadeOutMs;
  if (typeof fadeOutMs !== 'number' || !Number.isInteger(fadeOutMs) || fadeOutMs < 0 || fadeOutMs > MAX_FADE_MS) {
    return { ok: false, message: `Fade-out must be between 0 and ${MAX_FADE_MS} ms.` };
  }

  return {
    ok: true,
    value: {
      name: nameResult.value.name,
      category,
      color,
      shortcut,
      gainDb,
      fadeInMs,
      fadeOutMs,
    },
  };
}

function authorizeSoundMutation(user: SessionUser, sound: SoundRecord): SoundMutationResult | null {
  return canEditSound(user, sound) ? null : { ok: false, message: 'You can only modify your own sounds.' };
}

function shortcutConflictMessage(shortcut: string, soundName: string): string {
  const label = shortcut === 'space' ? 'Space' : shortcut.toUpperCase();
  return `Shortcut ${label} is already assigned to ${soundName}.`;
}

async function findShortcutConflict(
  dependencies: SoundboardActionDependencies,
  shortcut: string | null,
  excludedSoundId?: string,
): Promise<SoundRecord | null> {
  if (!shortcut) return null;
  const sounds = await dependencies.listSounds();
  return sounds.find((sound) => sound.id !== excludedSoundId && sound.shortcut === shortcut) ?? null;
}

function isShortcutUniquenessError(error: unknown): boolean {
  return error instanceof Error
    && /(?:Sound_shortcut_key|duplicate key value.*shortcut)/i.test(error.message);
}

async function shortcutRaceResult(
  dependencies: SoundboardActionDependencies,
  error: unknown,
  shortcut: string | null,
  excludedSoundId?: string,
): Promise<SoundMutationResult | null> {
  if (!shortcut || !isShortcutUniquenessError(error)) return null;
  try {
    const conflict = await findShortcutConflict(dependencies, shortcut, excludedSoundId);
    if (conflict) return { ok: false, message: shortcutConflictMessage(shortcut, conflict.name) };
  } catch {
    // Keep uniqueness races stable even when the follow-up lookup is unavailable.
  }
  const label = shortcut === 'space' ? 'Space' : shortcut.toUpperCase();
  return { ok: false, message: `Shortcut ${label} is already assigned to another sound.` };
}

function normalizeTrimRequest(input: { trimStartMs: number; trimEndMs: number }): SoundMutationResult<{
  trimStartMs: number;
  trimEndMs: number;
}> {
  if (![input.trimStartMs, input.trimEndMs].every(Number.isFinite)) {
    return { ok: false, message: 'Trim values must be finite numbers.' };
  }
  const trimStartMs = Math.round(input.trimStartMs);
  const trimEndMs = Math.round(input.trimEndMs);
  return validateTrimRange({ trimStartMs, trimEndMs, sourceDurationMs: trimEndMs });
}

export function createSoundboardActions(dependencies: SoundboardActionDependencies) {
  return {
    async listSoundboardData(): Promise<SoundboardData> {
      const user = await requireUser(dependencies);
      if (!user) throw new Error('Not authenticated.');
      const [sounds, selectedGuildId] = await Promise.all([
        dependencies.listSounds(),
        dependencies.getSelectedGuildId(),
      ]);
      const authorizedSelectedGuild = selectedGuildId && await dependencies.getAuthorizedGuildIds(user.id)
        .then((guildIds) => guildIds.includes(selectedGuildId))
        .catch(() => false);
      return {
        user: { id: user.id, username: user.username, role: user.role },
        selectedGuildId: authorizedSelectedGuild ? selectedGuildId : null,
        sounds: sounds.map(asClientSound),
      };
    },

    async playSound(input: PlaySoundInput): Promise<SoundboardActionResult<SoundboardSound>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      const soundId = validSoundId(input?.soundId);
      if (!soundId) return { ok: false, message: 'Sound id is required.' };
      const channelId = validChannelId(input?.channelId);
      if (!channelId) return { ok: false, message: 'Pick a voice channel first.' };
      const guildId = await dependencies.getSelectedGuildId();
      if (!guildId) return { ok: false, message: 'No server selected.' };

      try {
        const authorizedGuildIds = await dependencies.getAuthorizedGuildIds(user.id);
        if (!authorizedGuildIds.includes(guildId)) {
          return { ok: false, message: 'You are not a member of the selected server.' };
        }
        if (!await dependencies.canMemberUseVoiceChannel(guildId, channelId, user.id)) {
          return { ok: false, message: 'Pick a voice channel you can view and connect to in the selected server.' };
        }
        const sound = await dependencies.getSound(soundId);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const audioUrl = await dependencies.getSignedSoundUrl(sound.storagePath);
        await dependencies.sendSoundboardPlay({
          guildId,
          channelId,
          audioUrl,
          gainDb: sound.gainDb,
          fadeInMs: sound.fadeInMs,
          fadeOutMs: sound.fadeOutMs,
        });
        return { ok: true, value: asClientSound(sound) };
      } catch (error) {
        return actionError(error, 'Failed to play sound.');
      }
    },

    async stopSound(channelId: string): Promise<SoundboardActionResult> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      const normalizedChannelId = validChannelId(channelId);
      if (!normalizedChannelId) return { ok: false, message: 'Pick a voice channel first.' };
      const guildId = await dependencies.getSelectedGuildId();
      if (!guildId) return { ok: false, message: 'No server selected.' };

      try {
        const authorizedGuildIds = await dependencies.getAuthorizedGuildIds(user.id);
        if (!authorizedGuildIds.includes(guildId)) {
          return { ok: false, message: 'You are not a member of the selected server.' };
        }
        if (!await dependencies.canMemberUseVoiceChannel(guildId, normalizedChannelId, user.id)) {
          return { ok: false, message: 'Pick a voice channel you can view and connect to in the selected server.' };
        }
        await dependencies.sendSoundboardStop(guildId, normalizedChannelId);
        return { ok: true };
      } catch (error) {
        return actionError(error, 'Failed to stop sound.');
      }
    },

    async uploadSound(input: UploadSoundInput): Promise<SoundboardActionResult<SoundboardSound>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      if (!input || typeof input !== 'object') return { ok: false, message: 'Upload details are required.' };
      const metadata = validateMetadata(input, user.role === 'admin');
      if (!metadata.ok) return metadata;
      const file = input?.file;
      if (!file || typeof file.arrayBuffer !== 'function') return { ok: false, message: 'Choose an audio file to upload.' };
      const uploadMeta = validateUploadMeta(metadata.value.name, file.type, file.size);
      if (!uploadMeta.ok) return uploadMeta;
      const trim = normalizeTrimRequest(input);
      if (!trim.ok) return trim;

      try {
        const conflict = await findShortcutConflict(dependencies, metadata.value.shortcut);
        if (conflict) {
          return { ok: false, message: shortcutConflictMessage(metadata.value.shortcut!, conflict.name) };
        }
      } catch {
        return { ok: false, message: 'Failed to check the requested shortcut.' };
      }

      const soundId = dependencies.createSoundId();
      const uploadedPaths: string[] = [];
      let uploadRecoveryPrepared = false;
      let uploadRecoveryToken: string | null = null;
      const playableVersionId = dependencies.createSoundId();
      const expectedSourceStoragePath = `sounds/${user.id}/${soundId}/source`;
      const expectedPlayableStoragePath = `sounds/${user.id}/${soundId}/playable-${playableVersionId}`;
      try {
        const source = await file.arrayBuffer();
        const actualMeta = validateUploadMeta(metadata.value.name, file.type, source.byteLength);
        if (!actualMeta.ok || source.byteLength !== file.size) {
          return { ok: false, message: actualMeta.ok ? 'Uploaded file size changed during upload.' : actualMeta.message };
        }
        const sourceMimeType = detectSupportedAudioMimeType(new Uint8Array(source));
        if (!sourceMimeType) return { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' };
        const clip = await dependencies.trimSourceFile({
          source: new Uint8Array(source),
          mimeType: sourceMimeType,
          trimStartMs: trim.value.trimStartMs,
          trimEndMs: trim.value.trimEndMs,
        });
        const uploadLease = await dependencies.prepareSoundUploadRecovery({
          soundId,
          uploadedById: user.id,
          sourceStoragePath: expectedSourceStoragePath,
          playableStoragePath: expectedPlayableStoragePath,
        });
        uploadRecoveryPrepared = true;
        uploadRecoveryToken = uploadLease.token;
        const uploadedSourceStoragePath = await dependencies.uploadSource({
          uploadedById: user.id,
          soundId,
          file: source,
          mimeType: sourceMimeType,
        });
        uploadedPaths.push(uploadedSourceStoragePath);
        await dependencies.heartbeatSoundUploadRecovery({ soundId, token: uploadRecoveryToken });
        const storagePath = await dependencies.uploadPlayableClip({
          uploadedById: user.id,
          soundId,
          file: clip.buffer,
          mimeType: 'audio/wav',
          versionId: playableVersionId,
        });
        uploadedPaths.push(storagePath);
        await dependencies.heartbeatSoundUploadRecovery({ soundId, token: uploadRecoveryToken });
        const sound = await dependencies.insertSound({
          id: soundId,
          ...metadata.value,
          storagePath,
          sourceStoragePath: uploadedSourceStoragePath,
          mimeType: sourceMimeType,
          sizeBytes: source.byteLength,
          durationSec: clip.durationSec,
          uploadedById: user.id,
          uploadedByName: user.username,
          trimStartMs: trim.value.trimStartMs,
          trimEndMs: trim.value.trimEndMs,
          sortOrder: 0,
        });
        try {
          if (uploadRecoveryPrepared && uploadRecoveryToken) {
            await dependencies.completeSoundUploadRecovery({
              soundId,
              token: uploadRecoveryToken,
              sourceStoragePath: expectedSourceStoragePath,
              playableStoragePath: expectedPlayableStoragePath,
              outcome: 'row_committed',
            });
          }
        } catch {
          revalidateSoundboard(dependencies);
          return {
            ok: true,
            value: asClientSound(sound),
            warning: CLEANUP_WARNING,
            recoveryRequired: true,
          };
        }
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(sound) };
      } catch (error) {
        let cleanupWarning: string | null = null;
        let recoveryRequired = false;
        let cleanupPending = false;
        if (uploadRecoveryPrepared && uploadRecoveryToken) {
          try {
            await dependencies.markSoundUploadRecoveryPending({
              soundId,
              token: uploadRecoveryToken,
              lastError: 'Sound row insertion or upload failed; uploaded objects require cleanup.',
            });
          } catch {
            recoveryRequired = true;
          }
        }
        const cleanupPaths = [...new Set([
          expectedSourceStoragePath,
          expectedPlayableStoragePath,
          ...uploadedPaths,
        ])];
        for (const path of cleanupPaths.reverse()) {
          const cleanup = await cleanupWithRecovery(
            dependencies,
            { soundId, objectPath: path, cleanupKind: 'delete_object' },
            () => dependencies.deleteStorageObject(path),
          );
          if (!cleanup.cleaned) {
            cleanupWarning = CLEANUP_WARNING;
            cleanupPending = true;
            recoveryRequired = true;
          }
          recoveryRequired ||= cleanup.recoveryRequired;
        }
        if (uploadRecoveryPrepared && (!uploadRecoveryToken || !cleanupPending) && !recoveryRequired) {
          try {
            if (!uploadRecoveryToken) throw new Error('Upload recovery token is unavailable.');
            await dependencies.completeSoundUploadRecovery({
              soundId,
              token: uploadRecoveryToken,
              sourceStoragePath: expectedSourceStoragePath,
              playableStoragePath: expectedPlayableStoragePath,
              outcome: 'objects_absent',
            });
          } catch {
            recoveryRequired = true;
          }
        }
        const race = await shortcutRaceResult(dependencies, error, metadata.value.shortcut);
        if (race) return addRecoveryRequired(addWarning(race, cleanupWarning), recoveryRequired);
        return addRecoveryRequired(addWarning(actionError(error, 'Failed to upload sound.'), cleanupWarning), recoveryRequired);
      }
    },

    async updateSound(soundId: string, input: SoundMetadataInput): Promise<SoundboardActionResult<SoundboardSound>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      const id = validSoundId(soundId);
      if (!id) return { ok: false, message: 'Sound id is required.' };
      if (!input || typeof input !== 'object') return { ok: false, message: 'Sound details are required.' };
      let requestedShortcut: string | null = null;
      try {
        const sound = await dependencies.getSound(id);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const authorization = authorizeSoundMutation(user, sound);
        if (authorization) return authorization;
        const metadata = validateMetadata(
          input,
          user.role === 'admin',
          isSharedSoundCategory(sound.category) ? null : sound.category,
        );
        if (!metadata.ok) return metadata;
        requestedShortcut = metadata.value.shortcut;
        const conflict = await findShortcutConflict(dependencies, metadata.value.shortcut, sound.id);
        if (conflict) return { ok: false, message: shortcutConflictMessage(metadata.value.shortcut!, conflict.name) };
        const updated = await dependencies.updateSound(id, metadata.value);
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(updated) };
      } catch (error) {
        const race = await shortcutRaceResult(dependencies, error, requestedShortcut, id);
        if (race) return race;
        return actionError(error, 'Failed to update sound.');
      }
    },

    async trimSound(input: TrimSoundInput): Promise<SoundboardActionResult<SoundboardSound>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      if (!input || typeof input !== 'object') return { ok: false, message: 'Trim details are required.' };
      const soundId = validSoundId(input?.soundId);
      if (!soundId) return { ok: false, message: 'Sound id is required.' };
      const trim = normalizeTrimRequest(input);
      if (!trim.ok) return trim;

      try {
        const sound = await dependencies.getSound(soundId);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const authorization = authorizeSoundMutation(user, sound);
        if (authorization) return authorization;
      } catch (error) {
        return actionError(error, 'Failed to trim sound.');
      }

      return withSoundMutationLock(soundId, () => withDurableSoundMutation(
        dependencies,
        soundId,
        'trim',
        async (lease) => {
          let stagedPlayablePath: string | null = null;
          let committedSound: SoundRecord | null = null;
          try {
            const sound = await dependencies.getSound(soundId);
            if (!sound) return { ok: false, message: 'Sound not found.' };
            const authorization = authorizeSoundMutation(user, sound);
            if (authorization) return authorization;
            const source = await dependencies.downloadSource({ uploadedById: sound.uploadedById, soundId: sound.id });
            const sourceBytes = new Uint8Array(await source.arrayBuffer());
            const sourceMimeType = detectSupportedAudioMimeType(sourceBytes);
            if (!sourceMimeType) return { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' };
            const clip = await dependencies.trimSourceFile({
              source: sourceBytes,
              mimeType: sourceMimeType,
              trimStartMs: trim.value.trimStartMs,
              trimEndMs: trim.value.trimEndMs,
            });
            const versionId = dependencies.createSoundId();
            const generatedStoragePath = `sounds/${sound.uploadedById}/${sound.id}/playable-${versionId}`;
            await dependencies.prepareSoundTrimMutation({
              soundId: sound.id,
              lease,
              versionId,
              previousPlayablePath: sound.storagePath,
              sourceStoragePath: sound.sourceStoragePath,
              generatedStoragePath,
              trimStartMs: trim.value.trimStartMs,
              trimEndMs: trim.value.trimEndMs,
              sourceDurationSec: clip.sourceDurationSec,
              generatedDurationSec: clip.durationSec,
              sourceMimeType,
              generatedMimeType: 'audio/wav',
              sourceSizeBytes: sourceBytes.byteLength,
              generatedSizeBytes: clip.buffer.byteLength,
            });
            stagedPlayablePath = await dependencies.uploadPlayableClip({
              uploadedById: sound.uploadedById,
              soundId: sound.id,
              file: clip.buffer,
              mimeType: 'audio/wav',
              versionId,
            });
            await dependencies.markSoundMutationRecovery({
              soundId: sound.id,
              token: lease.token,
              operation: 'trim',
              state: 'trim_uploaded',
            });
            const updated = await dependencies.commitSoundTrim({
              soundId: sound.id,
              lease,
              storagePath: stagedPlayablePath,
              ...trim.value,
              durationSec: clip.durationSec,
            });
            if (!updated) {
              await dependencies.markSoundMutationRecovery({
                soundId: sound.id,
                token: lease.token,
                operation: 'trim',
                state: 'trim_abandoned',
              });
              const cleanup = await cleanupWithRecovery(
                dependencies,
                { soundId: sound.id, objectPath: stagedPlayablePath, cleanupKind: 'delete_object' },
                () => dependencies.deleteStorageObject(stagedPlayablePath!),
              );
              if (cleanup.cleaned) {
                await dependencies.completeSoundMutationRecovery({ soundId: sound.id, token: lease.token, operation: 'trim' });
              }
              stagedPlayablePath = null;
              return addRecoveryRequired(addWarning(
                { ok: false, message: 'Sound changed while trim was in progress. Please retry.' },
                cleanup.cleaned ? null : CLEANUP_WARNING,
              ), cleanup.recoveryRequired);
            }
            committedSound = updated;
            stagedPlayablePath = null;
            const previousClipCleanup = await cleanupWithRecovery(
              dependencies,
              { soundId: sound.id, objectPath: sound.storagePath, cleanupKind: 'delete_object' },
              () => dependencies.deleteStorageObject(sound.storagePath),
            );
            if (previousClipCleanup.cleaned) {
              await dependencies.completeSoundMutationRecovery({ soundId: sound.id, token: lease.token, operation: 'trim' });
            }
            revalidateSoundboard(dependencies);
            return addRecoveryRequired({
              ok: true,
              value: asClientSound(updated),
              ...(previousClipCleanup.cleaned ? {} : { warning: DELETE_CLEANUP_WARNING }),
            }, previousClipCleanup.recoveryRequired);
          } catch (error) {
            if (committedSound) {
              return {
                ok: true,
                value: asClientSound(committedSound),
                warning: DELETE_CLEANUP_WARNING,
                recoveryRequired: true,
              };
            }
            let recoveryRequired = false;
            let cleanupWarning: string | null = null;
            if (stagedPlayablePath) {
              const cleanup = await cleanupWithRecovery(
                dependencies,
                { soundId: soundId, objectPath: stagedPlayablePath, cleanupKind: 'delete_object' },
                () => dependencies.deleteStorageObject(stagedPlayablePath!),
              );
              if (!cleanup.cleaned) cleanupWarning = CLEANUP_WARNING;
              recoveryRequired ||= cleanup.recoveryRequired;
              if (cleanup.cleaned) {
                try {
                  await dependencies.completeSoundMutationRecovery({ soundId, token: lease.token, operation: 'trim' });
                } catch {
                  recoveryRequired = true;
                }
              }
            }
            const stagedRecoveryRequired = error instanceof Error
              && (error as Error & { recoveryRequired?: unknown }).recoveryRequired === true;
            return addRecoveryRequired(
              addWarning(actionError(error, 'Failed to trim sound.'), cleanupWarning),
              recoveryRequired || stagedRecoveryRequired,
            );
          }
        },
      ));
    },

    async getSoundPlayableUrl(soundId: string): Promise<SoundboardActionResult<string>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      const id = validSoundId(soundId);
      if (!id) return { ok: false, message: 'Sound id is required.' };
      try {
        const sound = await dependencies.getSound(id);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        return { ok: true, value: await dependencies.getSignedSoundUrl(sound.storagePath) };
      } catch (error) {
        return actionError(error, 'Failed to refresh the sound preview.');
      }
    },

    async getSoundSourceUrl(soundId: string): Promise<SoundboardActionResult<string>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      const id = validSoundId(soundId);
      if (!id) return { ok: false, message: 'Sound id is required.' };
      try {
        const sound = await dependencies.getSound(id);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const authorization = authorizeSoundMutation(user, sound);
        if (authorization) return authorization;
        return { ok: true, value: await dependencies.getSignedSoundUrl(sound.sourceStoragePath) };
      } catch (error) {
        return actionError(error, 'Failed to load the source audio.');
      }
    },

    async deleteSound(soundId: string): Promise<SoundboardActionResult> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      const id = validSoundId(soundId);
      if (!id) return { ok: false, message: 'Sound id is required.' };

      try {
        const sound = await dependencies.getSound(id);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const authorization = authorizeSoundMutation(user, sound);
        if (authorization) return authorization;
      } catch (error) {
        return actionError(error, 'Failed to delete sound.');
      }

      return withSoundMutationLock(id, () => withDurableSoundMutation(
        dependencies,
        id,
        'delete',
        async (lease) => {
          let stage: SoundFileDeletionStage | null = null;
          let originalSound: SoundRecord | null = null;
          let rowDeleted = false;
          try {
            const sound = await dependencies.getSound(id);
            if (!sound) return { ok: false, message: 'Sound not found.' };
            originalSound = sound;
            const authorization = authorizeSoundMutation(user, sound);
            if (authorization) return authorization;
            stage = await dependencies.stageSoundFilesForDeletion({
              sound,
              stageId: dependencies.createSoundId(),
              lease,
            });
            await dependencies.deleteSoundFiles(stage);
            await dependencies.markSoundMutationRecovery({
              soundId: sound.id,
              token: lease.token,
              operation: 'delete',
              state: 'delete_objects_removed',
            });
            if (!await dependencies.commitSoundDelete({ soundId: sound.id, lease })) {
              throw new Error('Sound changed while delete was in progress.');
            }
            rowDeleted = true;
            const stageCleanup = await cleanupWithRecovery(
              dependencies,
              { soundId: sound.id, objectPath: stage.stagedSourcePath, cleanupKind: 'discard_stage' },
              async () => {
                await dependencies.discardSoundFileStage(stage!);
              },
            );
            if (!stageCleanup.cleaned) {
              const playableQueued = await enqueueDurableCleanup(dependencies, {
                soundId: sound.id,
                objectPath: stage.stagedPlayablePath,
                cleanupKind: 'discard_stage',
              });
              revalidateSoundboard(dependencies);
              return addRecoveryRequired(
                { ok: true, warning: DELETE_CLEANUP_WARNING },
                stageCleanup.recoveryRequired || !playableQueued,
              );
            }
            try {
              await dependencies.completeSoundMutationRecovery({ soundId: sound.id, token: lease.token, operation: 'delete' });
            } catch {
              revalidateSoundboard(dependencies);
              return { ok: true, warning: DELETE_CLEANUP_WARNING, recoveryRequired: true };
            }
            revalidateSoundboard(dependencies);
            return { ok: true };
          } catch (error) {
            if (stage && !rowDeleted) {
              let recoveryRequired = false;
              try {
                await dependencies.markSoundMutationRecovery({
                  soundId: id,
                  token: lease.token,
                  operation: 'delete',
                  state: 'restore_pending',
                  lastError: 'Delete recovery is in progress.',
                });
              } catch {
                recoveryRequired = true;
              }
              let restoreResult: SoundRestoreResult | void;
              try {
                restoreResult = await dependencies.restoreSoundFiles(stage);
              } catch {
                restoreResult = { sourceRestored: false, playableRestored: false };
              }
              const restored = restoreResult === undefined
                || (restoreResult.sourceRestored && restoreResult.playableRestored);
              if (!restored) {
                // Recovery copies are the last remaining source of truth when
                // either live object could not be restored. Never discard them.
                return {
                  ok: false,
                  message: 'Failed to delete sound.',
                  warning: CLEANUP_WARNING,
                  recoveryRequired: true,
                };
              }
              if (originalSound) {
                const currentSound = await dependencies.getSound(id).catch(() => null);
                if (!currentSound) {
                  const sourceQueued = await enqueueDurableCleanup(dependencies, {
                    soundId: id,
                    objectPath: originalSound.sourceStoragePath,
                    cleanupKind: 'delete_object',
                  });
                  const playableQueued = await enqueueDurableCleanup(dependencies, {
                    soundId: id,
                    objectPath: originalSound.storagePath,
                    cleanupKind: 'delete_object',
                  });
                  recoveryRequired ||= !sourceQueued || !playableQueued;
                } else if (currentSound.storagePath !== originalSound.storagePath) {
                  const queued = await enqueueDurableCleanup(dependencies, {
                    soundId: id,
                    objectPath: originalSound.storagePath,
                    cleanupKind: 'delete_object',
                  });
                  recoveryRequired ||= !queued;
                }
              }
              const stageDiscarded = await cleanupWithRecovery(
                dependencies,
                { soundId: id, objectPath: stage.stagedSourcePath, cleanupKind: 'discard_stage' },
                () => dependencies.discardSoundFileStage(stage!),
              );
              if (!stageDiscarded.cleaned) {
                const playableQueued = await enqueueDurableCleanup(dependencies, {
                  soundId: id,
                  objectPath: stage.stagedPlayablePath,
                  cleanupKind: 'discard_stage',
                });
                recoveryRequired ||= stageDiscarded.recoveryRequired || !playableQueued;
                return addRecoveryRequired(
                  { ok: false, message: 'Failed to delete sound.', warning: CLEANUP_WARNING },
                  recoveryRequired,
                );
              }
              try {
                await dependencies.markSoundMutationRecovery({
                  soundId: id,
                  token: lease.token,
                  operation: 'delete',
                  state: 'delete_restored',
                });
                await dependencies.completeSoundMutationRecovery({ soundId: id, token: lease.token, operation: 'delete' });
              } catch {
                recoveryRequired = true;
              }
              return addRecoveryRequired(actionError(error, 'Failed to delete sound.'), recoveryRequired);
            }
            const stagedRecoveryRequired = error instanceof Error
              && (error as Error & { recoveryRequired?: unknown }).recoveryRequired === true;
            return addRecoveryRequired(actionError(error, 'Failed to delete sound.'), stagedRecoveryRequired);
          }
        },
      ));
    },

    async reorderSounds(soundIds: string[]): Promise<SoundboardActionResult> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      if (user.role !== 'admin') return { ok: false, message: 'Admins only.' };
      if (!Array.isArray(soundIds) || soundIds.some((id) => !validSoundId(id))) {
        return { ok: false, message: 'Sound order is invalid.' };
      }

      try {
        const sounds = await dependencies.listSounds();
        const expectedIds = new Set(sounds.map((sound) => sound.id));
        if (
          expectedIds.size !== soundIds.length ||
          new Set(soundIds).size !== soundIds.length ||
          soundIds.some((id) => !expectedIds.has(id))
        ) {
          return { ok: false, message: 'Sound order must include every global sound exactly once.' };
        }
        await dependencies.updateSoundOrder(soundIds);
        revalidateSoundboard(dependencies);
        return { ok: true };
      } catch (error) {
        return actionError(error, 'Failed to reorder sounds.');
      }
    },
  };
}

async function loadDefaultDependencies(): Promise<SoundboardActionDependencies> {
  const [session, guild, guilds, sounds, audio, control, cache] = await Promise.all([
    import('../../lib/session'),
    import('../../lib/guild'),
    import('../../lib/discord'),
    import('../../lib/sounds'),
    import('../../lib/audio'),
    import('../../lib/control'),
    import('next/cache'),
  ]);
  return {
    getSessionUser: session.getSoundboardSessionUser,
    getSelectedGuildId: guild.getSelectedGuildId,
    getAuthorizedGuildIds: async (discordUserId: string) => (await guilds.listAuthorizedGuilds(discordUserId)).map((item) => item.id),
    canMemberUseVoiceChannel: guilds.canMemberUseVoiceChannel,
    listSounds: sounds.listSounds,
    getSound: sounds.getSound,
    getSignedSoundUrl: sounds.getSignedSoundUrl,
    uploadSource: sounds.uploadSource,
    uploadPlayableClip: sounds.uploadPlayableClip,
    prepareSoundUploadRecovery: sounds.prepareSoundUploadRecovery,
    heartbeatSoundUploadRecovery: sounds.heartbeatSoundUploadRecovery,
    markSoundUploadRecoveryPending: sounds.markSoundUploadRecoveryPending,
    completeSoundUploadRecovery: sounds.completeSoundUploadRecovery,
    confirmStorageObjectAbsent: sounds.confirmStorageObjectAbsent,
    deleteStorageObject: sounds.deleteStorageObject,
    downloadSource: sounds.downloadSource,
    stageSoundFilesForDeletion: sounds.stageSoundFilesForDeletion,
    deleteSoundFiles: sounds.deleteSoundFiles,
    restoreSoundFiles: sounds.restoreSoundFiles,
    discardSoundFileStage: sounds.discardSoundFileStage,
    insertSound: sounds.insertSound,
    updateSound: sounds.updateSound,
    deleteSoundRow: sounds.deleteSoundRow,
    acquireSoundMutation: async (soundId, operation, token) => sounds.acquireSoundMutation({ soundId, operation, token }),
    releaseSoundMutation: async (soundId, token) => sounds.releaseSoundMutation({ soundId, token }),
    prepareSoundTrimMutation: sounds.prepareSoundTrimMutation,
    markSoundMutationRecovery: sounds.markSoundMutationRecovery,
    completeSoundMutationRecovery: sounds.completeSoundMutationRecovery,
    commitSoundTrim: sounds.commitSoundTrim,
    commitSoundDelete: sounds.commitSoundDelete,
    enqueueSoundCleanup: async (input) => sounds.enqueueSoundCleanupTask({
      soundId: input.soundId,
      objectPath: input.objectPath,
      cleanupKind: input.cleanupKind,
    }),
    reconcileSoundMutationRecoveries: () => sounds.reconcileSoundMutationRecoveries(),
    updateSoundOrder: sounds.updateSoundOrder,
    trimSourceFile: audio.trimSourceFile,
    sendSoundboardPlay: control.sendSoundboardPlay,
    sendSoundboardStop: control.sendSoundboardStop,
    revalidatePath: cache.revalidatePath,
    createSoundId: randomUUID,
  };
}

async function actionsForRequest() {
  return createSoundboardActions(await loadDefaultDependencies());
}

export async function listSoundboardData(): Promise<SoundboardData> {
  'use server';
  return (await actionsForRequest()).listSoundboardData();
}

export async function playSound(input: PlaySoundInput): Promise<SoundboardActionResult<SoundboardSound>> {
  'use server';
  return (await actionsForRequest()).playSound(input);
}

export async function stopSound(channelId: string): Promise<SoundboardActionResult> {
  'use server';
  return (await actionsForRequest()).stopSound(channelId);
}

export async function uploadSound(input: UploadSoundInput): Promise<SoundboardActionResult<SoundboardSound>> {
  'use server';
  return (await actionsForRequest()).uploadSound(input);
}

export async function updateSound(soundId: string, input: SoundMetadataInput): Promise<SoundboardActionResult<SoundboardSound>> {
  'use server';
  return (await actionsForRequest()).updateSound(soundId, input);
}

export async function trimSound(input: TrimSoundInput): Promise<SoundboardActionResult<SoundboardSound>> {
  'use server';
  return (await actionsForRequest()).trimSound(input);
}

export async function getSoundPlayableUrl(soundId: string): Promise<SoundboardActionResult<string>> {
  'use server';
  return (await actionsForRequest()).getSoundPlayableUrl(soundId);
}

export async function getSoundSourceUrl(soundId: string): Promise<SoundboardActionResult<string>> {
  'use server';
  return (await actionsForRequest()).getSoundSourceUrl(soundId);
}

export async function deleteSound(soundId: string): Promise<SoundboardActionResult> {
  'use server';
  return (await actionsForRequest()).deleteSound(soundId);
}

export async function reorderSounds(soundIds: string[]): Promise<SoundboardActionResult> {
  'use server';
  return (await actionsForRequest()).reorderSounds(soundIds);
}
