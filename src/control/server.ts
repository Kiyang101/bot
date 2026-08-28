/**
 * control/server.ts — Local HTTP control endpoint for the bot.
 *
 * Lets the web dashboard (a separate process) tell the running bot to speak
 * in a voice channel. Bound to 127.0.0.1 only and guarded by a shared secret
 * (`BOT_CONTROL_SECRET`) — it is NOT meant to be exposed to the internet.
 *
 *   POST /speak
 *   headers: { 'x-control-secret': <BOT_CONTROL_SECRET>, 'content-type': 'application/json' }
 *   body: { channelId, text, voice?, provider?: 'default' | 'voicevox', translate?: boolean }
 */

import http from 'node:http';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { voiceSession } from '../lib/voiceAI/session';
import { createVoicevoxTTS } from '../lib/voiceAI/providers/voicevox';
import { createGoogleTTS } from '../lib/voiceAI/providers/googletts';
import { resolveVoicevoxUrl, resolveTtsVoice, resolveGoogleLang } from '../lib/voiceAI/providers/config';
import { translateToJapanese } from '../lib/voiceAI/translate';
import { synthesize as synthesizeDefault } from '../lib/voiceAI/tts';
import type { TtsProvider } from '../lib/voiceAI/providers/types';
import {
  musicManager,
  SoundboardBusyError,
  type MusicSession,
} from '../lib/music/musicSession';
import { resolve as resolveTracks } from '../lib/music/ytdlp';
import { DEFAULT_VOLUME, type LoopMode, type MusicState, type Effect } from '../lib/music/types';
import { assertSupabaseResult } from '../lib/database';
import { getSupabaseAdmin } from '../lib/supabase';

interface SpeakBody {
  channelId?: string;
  text?: string;
  voice?: string;
  provider?: 'default' | 'voicevox' | 'google';
  translate?: boolean;
  speed?: number;
  pitch?: number;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Pick the TTS provider for a request. VOICEVOX (anime/Japanese) and Google TTS
 * (Thai & more) are forced when requested; otherwise `undefined` is returned so
 * the caller falls back to the bot's configured provider (AI_TTS_PROVIDER).
 * Speed/pitch tuning only applies to VOICEVOX; for Google TTS the `voice` field
 * is a language code.
 */
function buildTts(body: SpeakBody): TtsProvider | undefined {
  if (body.provider === 'voicevox') {
    return createVoicevoxTTS(resolveVoicevoxUrl(), resolveTtsVoice('voicevox'), {
      speed: typeof body.speed === 'number' ? body.speed : undefined,
      pitch: typeof body.pitch === 'number' ? body.pitch : undefined,
    });
  }
  if (body.provider === 'google') {
    return createGoogleTTS(resolveGoogleLang());
  }
  return undefined;
}

async function handleSpeak(client: Client, body: SpeakBody): Promise<{ spoken: string }> {
  const text = (body.text ?? '').trim();
  const channelId = (body.channelId ?? '').trim();
  if (!text) throw new Error('text is required');
  if (!channelId) throw new Error('channelId is required');

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('channelId is not a voice channel the bot can see');
  }

  // Optionally translate to Japanese (for VOICEVOX anime voices).
  const spoken = body.translate ? await translateToJapanese(text) : text;
  const tts = buildTts(body);

  await voiceSession.speak(channel as VoiceBasedChannel, spoken, body.voice || undefined, tts);
  return { spoken };
}

/**
 * Synthesize a clip for the dashboard's "Test" button WITHOUT joining a voice
 * channel — the audio bytes are returned so the user can hear them in their
 * browser before sending the bot to a channel. Uses the same provider/voice/
 * translate logic as {@link handleSpeak}.
 */
async function handlePreview(body: SpeakBody): Promise<{ audio: Buffer; spoken: string }> {
  const text = (body.text ?? '').trim();
  if (!text) throw new Error('text is required');

  const spoken = body.translate ? await translateToJapanese(text) : text;
  const tts = buildTts(body);
  const audio = tts
    ? await tts.synthesize(spoken, body.voice || undefined)
    : await synthesizeDefault(spoken, body.voice || undefined);

  if (!audio || audio.length === 0) {
    throw new Error(
      'No audio was produced — check the selected TTS engine/provider is running and configured.',
    );
  }
  return { audio, spoken };
}

/** Sniff an audio buffer's container so the browser gets a correct Content-Type. */
function sniffAudioMime(buf: Buffer): string {
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return 'audio/wav';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'application/octet-stream';
}

function handleLeave(body: { guildId?: string }): void {
  const guildId = (body.guildId ?? '').trim();
  if (!guildId) throw new Error('guildId is required');
  voiceSession.leave(guildId);
}

interface MusicBody {
  guildId?: string;
  channelId?: string;
  action?: string;
  query?: string;
  level?: number;
  mode?: LoopMode;
  position?: number;
  effect?: Effect;
  intensity?: number;
  seconds?: number;
}

export interface SoundboardBody {
  guildId?: string;
  channelId?: string;
  audioUrl?: string;
  gainDb?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

type SoundboardSession = Pick<MusicSession, 'playSound' | 'stopSound'>;

export interface SoundboardSessions {
  get(guildId: string): SoundboardSession | null;
  getOrCreate(guildId: string): SoundboardSession;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
  integer = false,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved)
    || resolved < min
    || resolved > max
    || (integer && !Number.isInteger(resolved))
  ) {
    throw new Error(`${label} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
  }
  return resolved;
}

async function resolveSoundboardChannel(
  client: Client,
  channelId: string,
  guildId: string,
): Promise<VoiceBasedChannel> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('channelId is not a voice channel the bot can see');
  }
  if (channel.guild?.id !== guildId) {
    throw new Error('channelId belongs to a different Discord server than guildId');
  }
  return channel as VoiceBasedChannel;
}

/** Handle a one-shot soundboard command without mutating the music queue. */
export async function handleSoundboard(
  client: Client,
  body: SoundboardBody,
  action: 'play' | 'stop',
  sessions: SoundboardSessions = musicManager,
): Promise<{ ok: true }> {
  const guildId = (body.guildId ?? '').trim();
  if (!guildId) throw new Error('guildId is required');
  if (Object.prototype.hasOwnProperty.call(body, 'loop')) {
    throw new Error('loop is not supported for soundboard playback');
  }

  const channelId = (body.channelId ?? '').trim();
  if (!channelId) throw new Error('channelId is required');

  if (action === 'stop') {
    await resolveSoundboardChannel(client, channelId, guildId);
    const session = sessions.get(guildId);
    // Stop is idempotent so a reload or second tab can safely request it even
    // when this process has no in-memory soundboard session.
    session?.stopSound();
    return { ok: true };
  }

  const rawAudioUrl = (body.audioUrl ?? '').trim();
  let audioUrl: URL;
  try {
    audioUrl = new URL(rawAudioUrl);
  } catch {
    throw new Error('audioUrl must be a server-resolved HTTP(S) URL');
  }
  if (audioUrl.protocol !== 'https:' && audioUrl.protocol !== 'http:') {
    throw new Error('audioUrl must be a server-resolved HTTP(S) URL');
  }

  const channel = await resolveSoundboardChannel(client, channelId, guildId);

  const gainDb = boundedNumber(body.gainDb, 0, -24, 12, 'gainDb');
  const fadeInMs = boundedNumber(body.fadeInMs, 0, 0, 5_000, 'fadeInMs', true);
  const fadeOutMs = boundedNumber(body.fadeOutMs, 0, 0, 5_000, 'fadeOutMs', true);
  await sessions.getOrCreate(guildId).playSound(channel, audioUrl.href, {
    gainDb,
    fadeInMs,
    fadeOutMs,
  });
  return { ok: true };
}

export function soundboardErrorResponse(error: unknown): {
  status: 409 | 500;
  payload: { error: string };
} {
  if (error instanceof SoundboardBusyError) {
    return { status: 409, payload: { error: 'soundboard_busy' } };
  }
  return {
    status: 500,
    payload: { error: 'soundboard_error' },
  };
}

/** An empty state for guilds with no active player. */
function emptyMusicState(): MusicState {
  return {
    current: null,
    queue: [],
    loop: 'off',
    effect: 'off',
    intensity: 50,
    volume: DEFAULT_VOLUME,
    positionSec: 0,
    playbackRate: 1,
    paused: false,
    channelId: null,
    channelName: null,
  };
}

/** Snapshot the music player for a guild (used by GET /music/state polling). */
function getMusicState(guildId: string): MusicState {
  if (!guildId) throw new Error('guildId is required');
  return musicManager.get(guildId)?.getState() ?? emptyMusicState();
}

/** Handle a POST /music command from the dashboard. */
async function handleMusic(client: Client, body: MusicBody): Promise<Record<string, unknown>> {
  const guildId = (body.guildId ?? '').trim();
  if (!guildId) throw new Error('guildId is required');

  if (body.action === 'play') {
    const channelId = (body.channelId ?? '').trim();
    const query = (body.query ?? '').trim();
    if (!channelId) throw new Error('channelId is required');
    if (!query) throw new Error('query is required');

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased()) {
      throw new Error('channelId is not a voice channel the bot can see');
    }
    if (channel.guild?.id !== guildId) {
      throw new Error('channelId belongs to a different Discord server than guildId');
    }

    const { tracks, kind } = await resolveTracks(query, 'dashboard', 'Dashboard');
    if (tracks.length === 0) throw new Error('No results found for that query.');
    // A free-text search enqueues just the top hit; URLs/playlists enqueue all
    // resolved tracks.
    const chosen = kind === 'search' ? [tracks[0]] : tracks;

    const session = musicManager.getOrCreate(guildId);
    const { added, startedNow } = await session.enqueue(channel as VoiceBasedChannel, null, chosen);
    const title = chosen[0]?.title ?? 'track';
    return {
      added,
      startedNow,
      kind,
      title,
      // Return the resolved tracks so the dashboard can persist canonical URLs
      // and replay history without resolving an old search term again.
      tracks: chosen.map((track) => ({
        title: track.title,
        url: track.url,
        durationSec: track.durationSec,
        thumbnail: track.thumbnail,
        uploader: track.uploader,
      })),
    };
  }

  // Every other action controls an existing session.
  const session = musicManager.get(guildId);
  if (!session) throw new Error('Nothing is playing in this server.');

  switch (body.action) {
    case 'skip':
      session.skip();
      break;
    case 'pause':
      session.pause();
      break;
    case 'resume':
      session.resume();
      break;
    case 'stop':
      session.stop();
      break;
    case 'shuffle':
      session.shuffle();
      break;
    case 'volume':
      session.setVolume(Number(body.level));
      break;
    case 'loop':
      session.setLoop((body.mode ?? 'off') as LoopMode);
      break;
    case 'remove':
      session.remove(Number(body.position));
      break;
    case 'jump':
      if (!session.jump(Number(body.position))) {
        throw new Error(`No track at position ${body.position}.`);
      }
      break;
    case 'effect':
      session.setEffect(
        (body.effect ?? 'off') as Effect,
        typeof body.intensity === 'number' ? body.intensity : undefined,
      );
      break;
    case 'intensity':
      session.setIntensity(Number(body.intensity));
      break;
    case 'seek':
      if (!(await session.seek(Number(body.seconds)))) {
        throw new Error('This track can’t be seeked (no known duration).');
      }
      break;
    default:
      throw new Error(`unknown music action: ${body.action}`);
  }
  return { ok: true };
}

/** Start the local control HTTP server. No-op if BOT_CONTROL_PORT is "0"/"off". */
export function startControlServer(client: Client, onStop: () => void): void {
  const portRaw = process.env.BOT_CONTROL_PORT ?? '8787';
  if (portRaw === '0' || portRaw.toLowerCase() === 'off') {
    console.log('[control] disabled (BOT_CONTROL_PORT=0)');
    return;
  }
  const port = Number(portRaw);
  const secret = process.env.BOT_CONTROL_SECRET ?? '';
  if (!secret) {
    console.warn(
      '[control] BOT_CONTROL_SECRET is not set — the control endpoint will reject all requests. ' +
        'Set the same secret here and in the dashboard.',
    );
  }

  const authorized = (req: http.IncomingMessage): boolean =>
    !!secret && req.headers['x-control-secret'] === secret;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const path = url.split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/status') {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        const runtime = assertSupabaseResult(
          'read BotRuntime',
          await getSupabaseAdmin().from('BotRuntime').select('*').eq('id', 1).maybeSingle(),
        );
        sendJson(res, 200, { ok: true, runtime });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'database unavailable' });
      }
      return;
    }

    // Live music state for the dashboard (polled). Secret-guarded.
    if (req.method === 'GET' && path === '/music/state') {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        const guildId = new URL(url, 'http://localhost').searchParams.get('guildId') ?? '';
        sendJson(res, 200, { ok: true, state: getMusicState(guildId) });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'unknown error' });
      }
      return;
    }

    const postRoutes = [
      '/speak',
      '/leave',
      '/music',
      '/preview',
      '/lifecycle',
      '/soundboard/play',
      '/soundboard/stop',
    ];
    if (req.method !== 'POST' || !postRoutes.includes(path)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as SpeakBody & MusicBody & SoundboardBody;
      if (path === '/lifecycle') {
        if (body.action !== 'stop') throw new Error('unsupported lifecycle action');
        sendJson(res, 202, { ok: true, status: 'STOPPING' });
        setImmediate(onStop);
        return;
      }
      if (path === '/leave') {
        handleLeave(body);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/music') {
        const result = await handleMusic(client, body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (path === '/soundboard/play' || path === '/soundboard/stop') {
        const result = await handleSoundboard(
          client,
          body,
          path === '/soundboard/play' ? 'play' : 'stop',
        );
        sendJson(res, 200, result);
        return;
      }
      if (path === '/preview') {
        const { audio, spoken } = await handlePreview(body);
        res.writeHead(200, {
          'Content-Type': sniffAudioMime(audio),
          'Content-Length': audio.length,
          // The (possibly translated) spoken text, URL-encoded so it's header-safe.
          'x-spoken': encodeURIComponent(spoken),
        });
        res.end(audio);
        return;
      }
      const result = await handleSpeak(client, body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[control] ${path} failed:`, message);
      if (path === '/soundboard/play' || path === '/soundboard/stop') {
        const response = soundboardErrorResponse(err);
        sendJson(res, response.status, response.payload);
      } else {
        sendJson(res, 500, { error: message });
      }
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[control] Port ${port} is already in use — another bot instance is probably still ` +
          `running. Stop it (or set a different BOT_CONTROL_PORT). The dashboard "Speak" page ` +
          `won't work until this is resolved.`,
      );
      return;
    }
    console.error('[control] server error:', err);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[control] HTTP control server listening on http://127.0.0.1:${port}`);
  });
}
