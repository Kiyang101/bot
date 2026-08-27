export type SoundCategory = string;

export interface SoundRecord {
  id: string;
  name: string;
  category: SoundCategory;
  color: string;
  storagePath: string;
  sourceStoragePath: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  uploadedById: string;
  uploadedByName: string;
  shortcut: string | null;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  trimStartMs: number;
  trimEndMs: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type SoundMutationResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface SoundPlaybackOptions {
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}
