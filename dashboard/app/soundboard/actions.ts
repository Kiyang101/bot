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
import type { NewSoundRecord, SoundRecordUpdate } from '../../lib/sounds';
import type { SoundboardPlayPayload } from '../../lib/control';

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
  sourceDurationMs: number;
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
  replacePlayableClip: (input: { uploadedById: string; soundId: string; file: Uint8Array; mimeType?: string }) => Promise<string>;
  downloadSource: (input: { uploadedById: string; soundId: string }) => Promise<Blob>;
  deleteSoundFiles: (input: { uploadedById: string; soundId: string }) => Promise<void>;
  insertSound: (input: NewSoundRecord) => Promise<SoundRecord>;
  updateSound: (id: string, input: SoundRecordUpdate) => Promise<SoundRecord>;
  deleteSoundRow: (id: string) => Promise<void>;
  updateSoundSortOrder: (id: string, sortOrder: number) => Promise<void>;
  trimSourceFile: (input: {
    source: Buffer | Uint8Array;
    mimeType: string;
    trimStartMs: number;
    trimEndMs: number;
  }) => Promise<{ buffer: Buffer; durationSec: number }>;
  sendSoundboardPlay: (payload: SoundboardPlayPayload) => Promise<void>;
  sendSoundboardStop: (guildId: string, channelId: string) => Promise<void>;
  revalidatePath: (path: string) => void;
  createSoundId: () => string;
}

function asClientSound(sound: SoundRecord): SoundboardSound {
  const { storagePath: _storagePath, sourceStoragePath: _sourceStoragePath, ...clientSound } = sound;
  return clientSound;
}

function actionError(error: unknown, fallback: string): SoundMutationResult {
  return { ok: false, message: error instanceof Error ? error.message : fallback };
}

async function requireUser(dependencies: SoundboardActionDependencies): Promise<SessionUser | null> {
  return dependencies.getSessionUser();
}

function revalidateSoundboard(dependencies: SoundboardActionDependencies): void {
  dependencies.revalidatePath('/soundboard');
  dependencies.revalidatePath('/soundboard/manage');
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
      if (!Number.isFinite(input.sourceDurationMs) || input.sourceDurationMs <= 0) {
        return { ok: false, message: 'Source duration is required.' };
      }
      const trim = validateTrimRange({
        trimStartMs: input.trimStartMs,
        trimEndMs: input.trimEndMs,
        sourceDurationMs: input.sourceDurationMs,
      });
      if (!trim.ok) return trim;

      const soundId = dependencies.createSoundId();
      let sourceUploaded = false;
      try {
        const source = await file.arrayBuffer();
        const actualMeta = validateUploadMeta(metadata.value.name, file.type, source.byteLength);
        if (!actualMeta.ok || source.byteLength !== file.size) {
          return { ok: false, message: actualMeta.ok ? 'Uploaded file size changed during upload.' : actualMeta.message };
        }
        const clip = await dependencies.trimSourceFile({
          source: new Uint8Array(source),
          mimeType: file.type,
          trimStartMs: trim.value.trimStartMs,
          trimEndMs: trim.value.trimEndMs,
        });
        const sourceStoragePath = await dependencies.uploadSource({
          uploadedById: user.id,
          soundId,
          file: source,
          mimeType: file.type,
        });
        sourceUploaded = true;
        const storagePath = await dependencies.replacePlayableClip({
          uploadedById: user.id,
          soundId,
          file: clip.buffer,
          mimeType: 'audio/wav',
        });
        const sound = await dependencies.insertSound({
          id: soundId,
          ...metadata.value,
          storagePath,
          sourceStoragePath,
          mimeType: file.type,
          sizeBytes: source.byteLength,
          durationSec: input.sourceDurationMs / 1_000,
          uploadedById: user.id,
          uploadedByName: user.username,
          trimStartMs: trim.value.trimStartMs,
          trimEndMs: trim.value.trimEndMs,
          sortOrder: 0,
        });
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(sound) };
      } catch (error) {
        if (sourceUploaded) {
          try {
            await dependencies.deleteSoundFiles({ uploadedById: user.id, soundId });
          } catch {
            // Preserve the primary failure; storage cleanup is best-effort after a failed insert.
          }
        }
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
        const updated = await dependencies.updateSound(id, metadata.value);
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(updated) };
      } catch (error) {
        return actionError(error, 'Failed to update sound.');
      }
    },

    async trimSound(input: TrimSoundInput): Promise<SoundboardActionResult<SoundboardSound>> {
      const user = await requireUser(dependencies);
      if (!user) return { ok: false, message: 'Not authenticated.' };
      if (!input || typeof input !== 'object') return { ok: false, message: 'Trim details are required.' };
      const soundId = validSoundId(input?.soundId);
      if (!soundId) return { ok: false, message: 'Sound id is required.' };

      try {
        const sound = await dependencies.getSound(soundId);
        if (!sound) return { ok: false, message: 'Sound not found.' };
        const authorization = authorizeSoundMutation(user, sound);
        if (authorization) return authorization;
        const sourceDurationMs = (sound.durationSec ?? 0) * 1_000;
        const trim = validateTrimRange({
          trimStartMs: input.trimStartMs,
          trimEndMs: input.trimEndMs,
          sourceDurationMs,
        });
        if (!trim.ok) return trim;
        const source = await dependencies.downloadSource({ uploadedById: sound.uploadedById, soundId: sound.id });
        const clip = await dependencies.trimSourceFile({
          source: new Uint8Array(await source.arrayBuffer()),
          mimeType: sound.mimeType,
          trimStartMs: trim.value.trimStartMs,
          trimEndMs: trim.value.trimEndMs,
        });
        await dependencies.replacePlayableClip({
          uploadedById: sound.uploadedById,
          soundId: sound.id,
          file: clip.buffer,
          mimeType: 'audio/wav',
        });
        const updated = await dependencies.updateSound(sound.id, trim.value);
        revalidateSoundboard(dependencies);
        return { ok: true, value: asClientSound(updated) };
      } catch (error) {
        return actionError(error, 'Failed to trim sound.');
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
        await dependencies.deleteSoundFiles({ uploadedById: sound.uploadedById, soundId: sound.id });
        await dependencies.deleteSoundRow(sound.id);
        revalidateSoundboard(dependencies);
        return { ok: true };
      } catch (error) {
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
        for (const [sortOrder, soundId] of soundIds.entries()) {
          await dependencies.updateSoundSortOrder(soundId, sortOrder);
        }
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
    getSessionUser: session.getSessionUser,
    getSelectedGuildId: guild.getSelectedGuildId,
    listSounds: sounds.listSounds,
    getSound: sounds.getSound,
    getSignedSoundUrl: sounds.getSignedSoundUrl,
    uploadSource: sounds.uploadSource,
    replacePlayableClip: sounds.replacePlayableClip,
    downloadSource: sounds.downloadSource,
    deleteSoundFiles: sounds.deleteSoundFiles,
    insertSound: sounds.insertSound,
    updateSound: sounds.updateSound,
    deleteSoundRow: sounds.deleteSoundRow,
    updateSoundSortOrder: sounds.updateSoundSortOrder,
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

export async function deleteSound(soundId: string): Promise<SoundboardActionResult> {
  'use server';
  return (await actionsForRequest()).deleteSound(soundId);
}

export async function reorderSounds(soundIds: string[]): Promise<SoundboardActionResult> {
  'use server';
  return (await actionsForRequest()).reorderSounds(soundIds);
}
