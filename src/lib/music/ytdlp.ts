/**
 * ytdlp.ts — Thin wrapper over `youtube-dl-exec` (the bundled `yt-dlp` binary).
 *
 * Two jobs:
 *   1. Resolve user input (a URL, a playlist, or a free-text search) into a list
 *      of {@link Track}s, using yt-dlp's JSON dump.
 *   2. Open a live audio stream for a track (yt-dlp → stdout) that we feed into
 *      `@discordjs/voice`, which transcodes it with ffmpeg.
 *
 * Set `YTDLP_PATH` in `.env` to use a system-installed yt-dlp instead of the
 * binary `youtube-dl-exec` downloads on install.
 */

import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import ytdlpDefault, { create as createYtdlp } from 'youtube-dl-exec';
import ffmpegStatic from 'ffmpeg-static';
import type { Track, Effect } from './types';

/** yt-dlp callable — custom binary if YTDLP_PATH is set, else the bundled one. */
const ytdlp = (() => {
  const custom = process.env.YTDLP_PATH?.trim();
  return custom ? createYtdlp(custom) : ytdlpDefault;
})();

/** Flags shared by every metadata lookup. */
const JSON_FLAGS = {
  dumpSingleJson: true,
  noWarnings: true,
  noCheckCertificates: true,
  preferFreeFormats: true,
} as const;

/**
 * Auth flags for yt-dlp, from env. YouTube increasingly blocks anonymous
 * requests with "Sign in to confirm you're not a bot"; passing your browser /
 * login cookies satisfies it. Configure ONE of:
 *   YTDLP_COOKIES_FROM_BROWSER=chrome|edge|firefox|brave|"chrome:Profile 1"
 *   YTDLP_COOKIES=C:\path\to\cookies.txt   (exported cookies.txt; takes priority)
 * Optionally override the extractor client (sometimes dodges the bot check):
 *   YTDLP_PLAYER_CLIENT=web_safari,android
 */
function authFlags(): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  const cookiesFile = process.env.YTDLP_COOKIES?.trim();
  const fromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  const hasCookies = !!(cookiesFile || fromBrowser);
  if (cookiesFile) flags.cookies = cookiesFile;
  else if (fromBrowser) flags.cookiesFromBrowser = fromBrowser;

  // The 'android' player client bypasses YouTube's "confirm you're not a bot"
  // wall with NO cookies/login — so default to it when no cookies are set. With
  // cookies, prefer the default client (gives true audio-only formats). An
  // explicit YTDLP_PLAYER_CLIENT always wins.
  const client = process.env.YTDLP_PLAYER_CLIENT?.trim() || (hasCookies ? '' : 'android');
  if (client) flags.extractorArgs = `youtube:player_client=${client}`;
  return flags;
}

/** Loose shape of the JSON yt-dlp emits — we only read a handful of fields. */
interface RawInfo {
  _type?: string;
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  duration?: number | null;
  uploader?: string | null;
  channel?: string | null;
  thumbnail?: string | null;
  thumbnails?: { url: string }[];
  entries?: RawInfo[];
}

export type ResolveKind = 'video' | 'playlist' | 'search';

function watchUrl(raw: RawInfo): string {
  // A full URL is preferred; flat playlist/search entries may only give an id.
  if (raw.webpage_url && /^https?:/i.test(raw.webpage_url)) return raw.webpage_url;
  if (raw.url && /^https?:/i.test(raw.url)) return raw.url;
  return `https://www.youtube.com/watch?v=${raw.id ?? ''}`;
}

function thumbOf(raw: RawInfo): string | null {
  if (raw.thumbnail) return raw.thumbnail;
  const list = raw.thumbnails;
  return list && list.length > 0 ? list[list.length - 1].url : null;
}

function toTrack(raw: RawInfo, requestedById: string, requestedByTag: string): Track {
  return {
    title: raw.title?.trim() || 'Unknown title',
    url: watchUrl(raw),
    durationSec: typeof raw.duration === 'number' ? raw.duration : null,
    thumbnail: thumbOf(raw),
    uploader: raw.uploader ?? raw.channel ?? null,
    requestedById,
    requestedByTag,
  };
}

/** Is this a YouTube/URL-shaped input rather than a search phrase? */
function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/** Playlist intent: a `list=` param that isn't an infinite radio/mix (RD…). */
function playlistId(input: string): string | null {
  try {
    const list = new URL(input).searchParams.get('list');
    if (list && !list.startsWith('RD')) return list;
  } catch {
    /* not a parseable URL */
  }
  return null;
}

/** Search YouTube, returning up to `limit` tracks (for the picker). */
export async function search(
  query: string,
  requestedById: string,
  requestedByTag: string,
  limit = 5,
): Promise<Track[]> {
  const info = (await ytdlp(`ytsearch${limit}:${query}`, {
    ...JSON_FLAGS,
    ...authFlags(),
    flatPlaylist: true,
  })) as unknown as RawInfo;
  const entries = info.entries ?? [];
  return entries.map((e) => toTrack(e, requestedById, requestedByTag));
}

/**
 * Resolve arbitrary user input into tracks.
 *   - free text → a search (multiple results, for a picker)
 *   - playlist URL → every entry
 *   - video URL → a single track
 */
export async function resolve(
  input: string,
  requestedById: string,
  requestedByTag: string,
): Promise<{ tracks: Track[]; kind: ResolveKind }> {
  if (!looksLikeUrl(input)) {
    return { tracks: await search(input, requestedById, requestedByTag, 5), kind: 'search' };
  }

  if (playlistId(input)) {
    const info = (await ytdlp(input, {
      ...JSON_FLAGS,
      ...authFlags(),
      flatPlaylist: true,
      yesPlaylist: true,
    })) as unknown as RawInfo;
    const entries = info.entries ?? [];
    return {
      tracks: entries.map((e) => toTrack(e, requestedById, requestedByTag)),
      kind: 'playlist',
    };
  }

  const info = (await ytdlp(input, {
    ...JSON_FLAGS,
    ...authFlags(),
    noPlaylist: true,
  })) as unknown as RawInfo;
  return { tracks: [toTrack(info, requestedById, requestedByTag)], kind: 'video' };
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/**
 * Build the ffmpeg `-af` filter chain for an effect at a given intensity
 * (0–100). Each effect maps intensity onto its natural parameter range; the
 * ranges are tuned so intensity 50 reproduces the original presets. Returns
 * '' when there's nothing to filter.
 */
function buildEffectFilter(effect: Effect, intensity: number): string {
  const t = Math.min(100, Math.max(0, intensity)) / 100;
  switch (effect) {
    case 'off':
      return '';
    case 'nightcore': {
      // Speed + pitch up. 50% → 1.25× (asetrate 60000).
      const rate = Math.round(48000 * lerp(1.1, 1.4, t));
      return `aresample=48000,asetrate=${rate},aresample=48000`;
    }
    case 'vaporwave': {
      // Slowed + lower pitch. 50% → 0.8× (asetrate 38400).
      const rate = Math.round(48000 * lerp(1.0, 0.6, t));
      return `aresample=48000,asetrate=${rate},aresample=48000`;
    }
    case 'bassboost': {
      // Low-shelf gain in dB. 50% → 12 dB.
      return `bass=g=${lerp(0, 24, t).toFixed(1)}`;
    }
    case 'treble': {
      // High-shelf gain in dB. 50% → 12 dB.
      return `treble=g=${lerp(0, 24, t).toFixed(1)}`;
    }
    case '8d': {
      // Panning rotation speed in Hz. 50% → 0.08 Hz.
      return `apulsator=hz=${lerp(0.02, 0.14, t).toFixed(3)}`;
    }
  }
}

/**
 * Speed multiplier an effect applies to playback (1 = normal). Only the
 * pitch/speed effects change it; used to convert played time into content time
 * for the seek bar and to keep the dashboard video in sync.
 */
export function effectPlaybackRate(effect: Effect, intensity: number): number {
  const t = Math.min(100, Math.max(0, intensity)) / 100;
  switch (effect) {
    case 'nightcore':
      return Number(lerp(1.1, 1.4, t).toFixed(3));
    case 'vaporwave':
      return Number(lerp(1.0, 0.6, t).toFixed(3));
    default:
      return 1;
  }
}

const FFMPEG = ffmpegStatic ?? 'ffmpeg';

/**
 * Resolve a direct, seekable media URL for a track (yt-dlp `-g`). Used so
 * ffmpeg can read the audio directly and input-seek into it (`-ss`), which is
 * what makes the seek bar possible. The URL is valid for a few hours.
 */
export async function getStreamUrl(track: Track): Promise<string> {
  const out = await ytdlp(track.url, {
    ...authFlags(),
    format: 'bestaudio[ext=webm]/bestaudio/best',
    getUrl: true,
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    quiet: true,
  });
  const url = String(out).trim().split('\n')[0]?.trim();
  if (!url || !/^https?:/i.test(url)) {
    throw new Error('Could not resolve a playable stream URL.');
  }
  return url;
}

/** A live audio stream plus a way to tear down its ffmpeg process. */
export interface AudioStream {
  /** Raw s16le PCM (48 kHz stereo) ready for `createAudioResource`. */
  stream: Readable;
  /** Kill the ffmpeg process backing this stream. */
  destroy: () => void;
}

export interface StreamOptions {
  effect?: Effect;
  intensity?: number;
  /** Playback volume 0–100 (baked into the ffmpeg filter — Opus passthrough). */
  volume?: number;
  /**
   * Start offset in seconds. 0 (or omitted) uses the robust yt-dlp pipe; a
   * positive value uses the direct-URL input-seek path (and requires `url`).
   */
  seekSec?: number;
  /** Source for normal playback (seekSec 0): streamed via yt-dlp. */
  track?: Track;
  /** Direct media URL from {@link getStreamUrl}, for seeking (seekSec > 0). */
  url?: string;
}

/**
 * Combine the effect filter and volume into one ffmpeg `-af` chain. With Opus
 * passthrough there's no PCM stage for inline volume, so volume is applied here.
 */
function buildFilterChain(effect: Effect, intensity: number, volume: number): string {
  const parts: string[] = [];
  const eff = buildEffectFilter(effect, intensity);
  if (eff) parts.push(eff);
  if (volume !== 100) parts.push(`volume=${Math.max(0, volume) / 100}`);
  return parts.join(',');
}

/**
 * ffmpeg args that output Ogg-Opus (48 kHz stereo, 20 ms frames). Fed to
 * `createAudioResource` with `StreamType.OggOpus`, @discordjs/voice forwards the
 * Opus packets straight to Discord with NO per-frame PCM volume transform or
 * Opus encode on the main thread — the lightest possible send loop, most
 * resistant to event-loop jitter. `-frame_duration 20` guarantees Discord's
 * required framing so there's no clock drift.
 */
function opusArgs(filter: string): string[] {
  return [
    '-vn',
    ...(filter ? ['-af', filter] : []),
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-application', 'audio',
    '-frame_duration', '20',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'opus',
    'pipe:1',
  ];
}

/** Wrap an ffmpeg child as an {@link AudioStream}, logging real failures. */
function wrapFfmpeg(ff: ReturnType<typeof spawn>, label: string, alsoKill?: () => void): AudioStream {
  let killed = false;

  // Reserve buffer: ffmpeg races ahead and keeps ~10s of PCM queued so brief
  // source / CPU / network hiccups never starve the 20 ms send loop — that
  // starvation is what causes the light, occasional stutter. Backpressure pauses
  // ffmpeg once the buffer is full. We do NOT destroy this on ffmpeg's natural
  // end, so the queued tail still plays out to the end of the track.
  const buffer = new PassThrough({ highWaterMark: 1 << 21 }); // ~2 MB ≈ 10 s of PCM
  ff.stdout!.pipe(buffer);
  ff.stdout!.on('error', () => {});

  // Keep the tail of ffmpeg's stderr so a real failure is diagnosable.
  let errTail = '';
  ff.stderr?.on('data', (d: Buffer) => {
    errTail = (errTail + d.toString()).slice(-600);
  });
  ff.on('exit', (code, signal) => {
    if (!killed && signal !== 'SIGKILL' && code && code !== 0) {
      console.error(`[music] ffmpeg(${label}) exited ${code}: ${errTail.trim() || '(no stderr)'}`);
    }
  });

  const destroy = () => {
    if (killed) return;
    killed = true;
    try {
      ff.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    buffer.destroy();
    alsoKill?.();
  };
  ff.on('error', (e) => {
    console.error(`[music] ffmpeg(${label}) spawn error:`, e.message);
    destroy();
  });
  return { stream: buffer, destroy };
}

/**
 * Open a live audio stream, applying an audio effect and optionally seeking.
 *
 * - Normal playback (`seekSec` 0): yt-dlp downloads best audio and pipes it
 *   into ffmpeg. This is the reliable path — yt-dlp handles YouTube's headers,
 *   throttling, and CDN quirks that trip up reading the media URL directly.
 * - Seeking (`seekSec` > 0): ffmpeg reads the direct `url` and input-seeks with
 *   `-ss` before `-i` (fast, byte-range based).
 *
 * Both output Ogg-Opus (48 kHz stereo) for `createAudioResource` with
 * `StreamType.OggOpus` — passed straight to Discord without re-encoding.
 */
export function createAudioStream(opts: StreamOptions): AudioStream {
  const { effect = 'off', intensity = 50, volume = 100, seekSec = 0 } = opts;
  const filter = buildFilterChain(effect, intensity, volume);

  // Seek path: read the direct URL with input seek.
  if (seekSec > 0) {
    if (!opts.url) throw new Error('Seeking requires a resolved stream URL.');
    const ff = spawn(
      FFMPEG,
      [
        '-loglevel', 'error',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-ss', String(seekSec),
        '-i', opts.url,
        ...opusArgs(filter),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return wrapFfmpeg(ff, 'seek');
  }

  // Normal path: yt-dlp → ffmpeg pipe.
  if (!opts.track) throw new Error('createAudioStream needs a track for normal playback.');
  const yt = ytdlp.exec(
    opts.track.url,
    {
      ...authFlags(),
      output: '-',
      format: 'bestaudio[ext=webm]/bestaudio/best',
      noPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
      quiet: true,
    },
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ytOut = yt.stdout;
  if (!ytOut) throw new Error('yt-dlp produced no audio stream.');

  // The youtube-dl-exec subprocess is also a promise that REJECTS when the
  // process is killed (SIGKILL on skip/stop/track-end) or exits non-zero.
  // Swallow it — an unhandled rejection here crashes the whole bot.
  yt.catch(() => {});

  // Surface yt-dlp errors (e.g. age/region/login-gated video, format not found)
  // so a failed download is visible instead of just producing silence.
  let ytErrTail = '';
  yt.stderr?.on('data', (d: Buffer) => {
    ytErrTail = (ytErrTail + d.toString()).slice(-600);
  });
  yt.on?.('exit', (code: number | null, signal: string | null) => {
    if (signal !== 'SIGKILL' && code && code !== 0) {
      console.error(`[music] yt-dlp exited ${code} for "${opts.track?.title}": ${ytErrTail.trim() || '(no stderr)'}`);
    }
  });

  const ff = spawn(
    FFMPEG,
    ['-loglevel', 'error', '-i', 'pipe:0', ...opusArgs(filter)],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  ytOut.pipe(ff.stdin);
  ytOut.on('error', () => {});
  ff.stdin.on('error', () => {});

  return wrapFfmpeg(ff, 'pipe', () => {
    try {
      yt.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  });
}
