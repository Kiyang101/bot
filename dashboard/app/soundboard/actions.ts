import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../../lib/auth';
import {
  MAX_FADE_MS,
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  canEditSound,
  normalizeShortcut,
  validateTrimRange,
  validateUploadMeta,
} from '../../lib/sound-validation';
import type { SoundMutationResult, SoundRecord } from '../../lib/sound-types';
import type { NewSoundRecord, SoundFileDeletionStage, SoundRecordUpdate } from '../../lib/sounds';
import { SoundboardBusyError, type SoundboardPlayPayload } from '../../lib/control';
import { detectSupportedAudioMimeType } from '../../lib/audio';

export type SoundboardSound = Omit<SoundRecord, 'storagePath' | 'sourceStoragePath'>;
export type SoundboardActionResult<T = undefined> = SoundMutationResult<T> | { ok: true; value?: T };

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
  listSounds: () => Promise<SoundRecord[]>;
  getSound: (id: string) => Promise<SoundRecord | null>;
  getSignedSoundUrl: (path: string) => Promise<string>;
  uploadSource: (input: { uploadedById: string; soundId: string; file: ArrayBuffer; mimeType: string }) => Promise<string>;
  uploadPlayableClip: (input: { uploadedById: string; soundId: string; file: Uint8Array; mimeType?: string; versionId: string }) => Promise<string>;
  deleteStorageObject: (path: string) => Promise<void>;
  downloadSource: (input: { uploadedById: string; soundId: string }) => Promise<Blob>;
  stageSoundFilesForDeletion: (input: {
    sound: Pick<SoundRecord, 'id' | 'uploadedById' | 'sourceStoragePath' | 'storagePath' | 'mimeType'>;
    stageId: string;
  }) => Promise<SoundFileDeletionStage>;
  deleteSoundFiles: (stage: SoundFileDeletionStage) => Promise<void>;
  restoreSoundFiles: (stage: SoundFileDeletionStage) => Promise<void>;
  discardSoundFileStage: (stage: SoundFileDeletionStage) => Promise<void>;
  insertSound: (input: NewSoundRecord) => Promise<SoundRecord>;
  updateSound: (id: string, input: SoundRecordUpdate) => Promise<SoundRecord>;
  deleteSoundRow: (id: string) => Promise<void>;
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

function actionError(error: unknown, fallback: string): SoundMutationResult {
  if (error instanceof SoundboardBusyError) return { ok: false, message: error.message };
  if (error instanceof Error && PUBLIC_PROCESSING_MESSAGES.has(error.message)) {
    return { ok: false, message: error.message };
  }
  return { ok: false, message: fallback };
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

function validateMetadata(input: Partial<SoundMetadataInput> | null | undefined): SoundMutationResult<ValidSoundMetadata> {
  const name = typeof input?.name === 'string' ? input.name : '';
  const nameResult = validateUploadMeta(name, 'audio/wav', 0);
  if (!nameResult.ok) return nameResult;

  const category = typeof input?.category === 'string' ? input.category.trim() : '';
  if (!category || category.length > 40) return { ok: false, message: 'Category must be between 1 and 40 characters.' };

  const color = typeof input?.color === 'string' ? input.color.trim() : '';
  if (!/^#[0-9a-f]{6}$/i.test(color)) return { ok: false, message: 'Choose a valid sound color.' };

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
      return {
        user: { id: user.id, username: user.username, role: user.role },
        selectedGuildId,
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
      const metadata = validateMetadata(input);
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
        const sourceStoragePath = await dependencies.uploadSource({
          uploadedById: user.id,
          soundId,
          file: source,
          mimeType: sourceMimeType,
        });
        uploadedPaths.push(sourceStoragePath);
        const storagePath = await dependencies.uploadPlayableClip({
          uploadedById: user.id,
          soundId,
          file: clip.buffer,
          mimeType: 'audio/wav',
          versionId: dependencies.createSoundId(),
        });
        uploadedPaths.push(storagePath);
        const sound = await dependencies.insertSound({
          id: soundId,
          ...metadata.value,
          storagePath,
          sourceStoragePath,
          mimeType: sourceMimeType,
          sizeBytes: source.byteLength,
          durationSec: clip.durationSec,
          uploadedById: user.id,
          uploadedByName: user.username,
          trimStartMs: trim.value.trimStartMs,
          trimEndMs: trim.value.trimEndMs,
          sortOrder: 0,
        });
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(sound) };
      } catch (error) {
        for (const path of uploadedPaths.reverse()) {
          await dependencies.deleteStorageObject(path).catch(() => undefined);
        }
        const race = await shortcutRaceResult(dependencies, error, metadata.value.shortcut);
        if (race) return race;
        return actionError(error, 'Failed to upload sound.');
      }
    },

    async updateSound(soundId: string, input: SoundMetadataInput): Promise<SoundboardActionResult<SoundboardSound>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      const id = validSoundId(soundId);
      if (!id) return { ok: false, message: 'Sound id is required.' };
      if (!input || typeof input !== 'object') return { ok: false, message: 'Sound details are required.' };
      const metadata = validateMetadata(input);
      if (!metadata.ok) return metadata;

      try {
        const sound = await dependencies.getSound(id);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const authorization = authorizeSoundMutation(user, sound);
        if (authorization) return authorization;
        const conflict = await findShortcutConflict(dependencies, metadata.value.shortcut, sound.id);
        if (conflict) return { ok: false, message: shortcutConflictMessage(metadata.value.shortcut!, conflict.name) };
        const updated = await dependencies.updateSound(id, metadata.value);
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(updated) };
      } catch (error) {
        const race = await shortcutRaceResult(dependencies, error, metadata.ok ? metadata.value.shortcut : null, id);
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

      let stagedPlayablePath: string | null = null;
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
        stagedPlayablePath = await dependencies.uploadPlayableClip({
          uploadedById: sound.uploadedById,
          soundId: sound.id,
          file: clip.buffer,
          mimeType: 'audio/wav',
          versionId: dependencies.createSoundId(),
        });
        const updated = await dependencies.updateSound(sound.id, {
          storagePath: stagedPlayablePath,
          ...trim.value,
          durationSec: clip.durationSec,
        });
        stagedPlayablePath = null;
        await dependencies.deleteStorageObject(sound.storagePath).catch(() => undefined);
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(updated) };
      } catch (error) {
        if (stagedPlayablePath) await dependencies.deleteStorageObject(stagedPlayablePath).catch(() => undefined);
        return actionError(error, 'Failed to trim sound.');
      }
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

      let stage: SoundFileDeletionStage | null = null;
      try {
        const sound = await dependencies.getSound(id);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const authorization = authorizeSoundMutation(user, sound);
        if (authorization) return authorization;
        stage = await dependencies.stageSoundFilesForDeletion({ sound, stageId: dependencies.createSoundId() });
        await dependencies.deleteSoundFiles(stage);
        await dependencies.deleteSoundRow(sound.id);
        await dependencies.discardSoundFileStage(stage).catch(() => undefined);
        revalidateSoundboard(dependencies);
        return { ok: true };
      } catch (error) {
        if (stage) {
          try {
            await dependencies.restoreSoundFiles(stage);
            await dependencies.discardSoundFileStage(stage).catch(() => undefined);
          } catch {
            return { ok: false, message: 'Failed to delete sound. Recovery copies were retained for an administrator.' };
          }
        }
        return actionError(error, 'Failed to delete sound.');
      }
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
  const [session, guild, sounds, audio, control, cache] = await Promise.all([
    import('../../lib/session'),
    import('../../lib/guild'),
    import('../../lib/sounds'),
    import('../../lib/audio'),
    import('../../lib/control'),
    import('next/cache'),
  ]);
  return {
    getSessionUser: session.getSoundboardSessionUser,
    getSelectedGuildId: guild.getSelectedGuildId,
    listSounds: sounds.listSounds,
    getSound: sounds.getSound,
    getSignedSoundUrl: sounds.getSignedSoundUrl,
    uploadSource: sounds.uploadSource,
    uploadPlayableClip: sounds.uploadPlayableClip,
    deleteStorageObject: sounds.deleteStorageObject,
    downloadSource: sounds.downloadSource,
    stageSoundFilesForDeletion: sounds.stageSoundFilesForDeletion,
    deleteSoundFiles: sounds.deleteSoundFiles,
    restoreSoundFiles: sounds.restoreSoundFiles,
    discardSoundFileStage: sounds.discardSoundFileStage,
    insertSound: sounds.insertSound,
    updateSound: sounds.updateSound,
    deleteSoundRow: sounds.deleteSoundRow,
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
