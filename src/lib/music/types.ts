/**
 * types.ts — Shared types for the YouTube music player.
 */

/** A single playable track resolved from YouTube via yt-dlp. */
export interface Track {
  /** Human-readable title shown in embeds. */
  title: string;
  /** Canonical YouTube watch URL — also what we hand to yt-dlp for streaming. */
  url: string;
  /** Duration in seconds, or null when yt-dlp didn't report one (e.g. live). */
  durationSec: number | null;
  /** Thumbnail URL for the now-playing embed, if available. */
  thumbnail: string | null;
  /** Channel / uploader name, if available. */
  uploader: string | null;
  /** Discord user id of whoever queued it. */
  requestedById: string;
  /** Discord tag/displayName of whoever queued it (for display). */
  requestedByTag: string;
}

/** Queue repeat behaviour. */
export type LoopMode = 'off' | 'track' | 'queue';

/** Audio effect applied through an ffmpeg filter chain. */
export type Effect = 'off' | 'nightcore' | 'vaporwave' | 'bassboost' | 'treble' | '8d';

/** Ordered list of effects, for cycling and for building command choices. */
export const EFFECTS: Effect[] = ['off', 'nightcore', 'vaporwave', 'bassboost', 'treble', '8d'];

/** Short human labels for each effect (UI + embeds). */
export const EFFECT_LABELS: Record<Effect, string> = {
  off: 'Off',
  nightcore: 'Nightcore',
  vaporwave: 'Vaporwave',
  bassboost: 'Bass Boost',
  treble: 'Treble',
  '8d': '8D Audio',
};

/**
 * Effect intensity as a 0–100 percentage. 50 is the tuned default and
 * reproduces each effect's original preset; higher is stronger. The 'off'
 * effect ignores intensity.
 */
export const DEFAULT_INTENSITY = 50;

/** Starting playback volume for new music sessions. */
export const DEFAULT_VOLUME = 80;

/** A flat snapshot of a guild's player, used to render embeds and replies. */
export interface MusicState {
  current: Track | null;
  queue: Track[];
  loop: LoopMode;
  effect: Effect;
  intensity: number; // 0–100, applies to the active effect
  volume: number; // 0–100
  /** Playback position of the current track, in seconds. */
  positionSec: number;
  /** Speed multiplier from the active effect (1 = normal). */
  playbackRate: number;
  paused: boolean;
  /** Discord voice channel id the session is currently bound to, if any. */
  channelId: string | null;
  /** Voice channel name the bot is playing in, if connected. */
  channelName: string | null;
}
