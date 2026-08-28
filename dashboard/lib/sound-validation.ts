import type { SoundRecord } from './sound-types';

export const MAX_SOUND_BYTES = 10 * 1024 * 1024;
export const MAX_SOUND_NAME_LENGTH = 60;
export const MIN_CLIP_LENGTH_MS = 100;
export const MIN_GAIN_DB = -24;
export const MAX_GAIN_DB = 12;
export const MAX_FADE_MS = 5000;
export const SOUND_CATEGORIES = ['Reactions', 'Memes', 'Music'] as const;
export const SOUND_COLOR_OPTIONS = ['#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#ed4245'] as const;

export const SUPPORTED_SOUND_MIME_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
] as const;

type ValidationFailure = { ok: false; message: string };
type ValidationSuccess<T> = { ok: true; value: T };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function validateUploadMeta(
  name: string,
  mimeType: string,
  sizeBytes: number,
): ValidationResult<{ name: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) return { ok: false, message: 'Sound name is required.' };
  if (trimmedName.length > MAX_SOUND_NAME_LENGTH) {
    return { ok: false, message: `Sound name must be ${MAX_SOUND_NAME_LENGTH} characters or fewer.` };
  }
  if (!(SUPPORTED_SOUND_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' };
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_SOUND_BYTES) {
    return { ok: false, message: `Sound must be no larger than ${MAX_SOUND_BYTES} bytes.` };
  }
  return { ok: true, value: { name: trimmedName } };
}

export function validateTrimRange(input: {
  trimStartMs: number;
  trimEndMs: number;
  sourceDurationMs: number;
}): ValidationResult<{ trimStartMs: number; trimEndMs: number }> {
  const { trimStartMs, trimEndMs, sourceDurationMs } = input;
  if (![trimStartMs, trimEndMs, sourceDurationMs].every(Number.isFinite)) {
    return { ok: false, message: 'Trim values must be finite numbers.' };
  }
  if (trimStartMs < 0 || trimEndMs > sourceDurationMs || trimStartMs >= trimEndMs) {
    return { ok: false, message: 'Trim range must fit inside the source duration.' };
  }
  if (trimEndMs - trimStartMs < MIN_CLIP_LENGTH_MS) {
    return { ok: false, message: `Sound clips must be at least ${MIN_CLIP_LENGTH_MS} ms long.` };
  }
  return { ok: true, value: { trimStartMs, trimEndMs } };
}

export function normalizeShortcut(shortcut: string): string | null {
  if (shortcut === ' ') return 'space';
  if (Array.from(shortcut).length !== 1) return null;
  const codePoint = shortcut.codePointAt(0);
  if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) return null;
  return shortcut.toLowerCase();
}

export function isPresetSoundColor(color: string): boolean {
  return (SOUND_COLOR_OPTIONS as readonly string[]).includes(color.toLowerCase());
}

export function isSharedSoundCategory(category: string): boolean {
  return (SOUND_CATEGORIES as readonly string[]).includes(category as (typeof SOUND_CATEGORIES)[number]);
}

type MutatingUser = { id: string; role: 'admin' | 'member' };
type OwnedSound = Pick<SoundRecord, 'uploadedById'> | { uploadedById: string };

export function canEditSound(user: MutatingUser, sound: OwnedSound): boolean {
  return user.role === 'admin' || user.id === sound.uploadedById;
}

export function canDeleteSound(user: MutatingUser, sound: OwnedSound): boolean {
  return canEditSound(user, sound);
}

type SoundRow = Record<string, unknown>;

export function mapSoundRow(row: SoundRow): SoundRecord {
  const value = (camel: string, snake: string = camel) =>
    Object.prototype.hasOwnProperty.call(row, camel) ? row[camel] : row[snake];
  return {
    id: value('id') as string,
    name: value('name') as string,
    category: value('category') as string,
    color: value('color') as string,
    storagePath: value('storagePath', 'storage_path') as string,
    sourceStoragePath: value('sourceStoragePath', 'source_storage_path') as string,
    mimeType: value('mimeType', 'mime_type') as string,
    sizeBytes: value('sizeBytes', 'size_bytes') as number,
    durationSec: value('durationSec', 'duration_sec') as number | null,
    uploadedById: value('uploadedById', 'uploaded_by_id') as string,
    uploadedByName: value('uploadedByName', 'uploaded_by_name') as string,
    shortcut: value('shortcut') as string | null,
    gainDb: value('gainDb', 'gain_db') as number,
    fadeInMs: value('fadeInMs', 'fade_in_ms') as number,
    fadeOutMs: value('fadeOutMs', 'fade_out_ms') as number,
    trimStartMs: value('trimStartMs', 'trim_start_ms') as number,
    trimEndMs: value('trimEndMs', 'trim_end_ms') as number,
    sortOrder: value('sortOrder', 'sort_order') as number,
    createdAt: value('createdAt', 'created_at') as string,
    updatedAt: value('updatedAt', 'updated_at') as string,
  };
}
