import type { Client } from 'discord.js';
import { musicManager, SoundboardBusyError, type MusicSession } from '../../features/music/musicSession';
import { resolveSoundboardChannel, resolveDashboardVoiceChannel } from '../channels';

export interface SoundboardBody {
  guildId?: string;
  channelId?: string;
  userId?: string;
  audioUrl?: string;
  gainDb?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  durationSec?: number;
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

  if (action === 'stop') {
    if (!channelId) throw new Error('channelId is required');
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

  const channel = await resolveDashboardVoiceChannel(client, guildId, channelId, body.userId);

  const gainDb = boundedNumber(body.gainDb, 0, -24, 12, 'gainDb');
  const fadeInMs = boundedNumber(body.fadeInMs, 0, 0, 5_000, 'fadeInMs', true);
  const fadeOutMs = boundedNumber(body.fadeOutMs, 0, 0, 5_000, 'fadeOutMs', true);
  const durationSec = body.durationSec == null
    ? undefined
    : boundedNumber(body.durationSec, 0, 0, 86_400, 'durationSec');
  await sessions.getOrCreate(guildId).playSound(channel, audioUrl.href, {
    gainDb,
    fadeInMs,
    fadeOutMs,
    durationSec,
  });
  return { ok: true };
}

export function soundboardErrorResponse(error: unknown): {
  status: 400 | 409 | 500;
  payload: { error: string };
} {
  if (error instanceof SoundboardBusyError) {
    return { status: 409, payload: { error: 'soundboard_busy' } };
  }
  if (error instanceof Error && (
    error.message === 'channelId is required'
    || error.message === 'channelId or userId is required'
    || error.message === 'You must be in a voice channel to use automatic connection.'
  )) {
    return { status: 400, payload: { error: error.message } };
  }
  return {
    status: 500,
    payload: { error: 'soundboard_error' },
  };
}
