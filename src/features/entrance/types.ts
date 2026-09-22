export const ENTRANCE_MAX_SECONDS = 5;
export const ENTRANCE_MIN_SECONDS = 0.1;
export const ENTRANCE_MAX_AGE_MS = 3000;
export type EntrancePreference = {
  enabled: boolean; soundId: string | null; mode?: 'sound' | 'speech';
  speechPath?: string | null; speechDurationSec?: number | null;
};
export type EntranceSound = {
  url: string; durationSec: number; gainDb: number; fadeInMs: number; fadeOutMs: number;
};
export type EntranceResult = 'played' | 'ineligible' | 'disabled' | 'cooldown' | 'busy' | 'stale' | 'channel_changed' | 'sound_unavailable' | 'playback_failed';
