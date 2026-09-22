import type { Client, VoiceBasedChannel } from 'discord.js';
import { musicManager } from '../../features/music/musicSession';
import { resolve as resolveTracks } from '../../features/music/ytdlp';
import { DEFAULT_VOLUME, type LoopMode, type MusicState, type Effect } from '../../features/music/types';
import { resolveDashboardVoiceChannel } from '../channels';

export interface MusicBody {
  guildId?: string;
  channelId?: string;
  userId?: string;
  action?: string;
  query?: string;
  level?: number;
  mode?: LoopMode;
  position?: number;
  effect?: Effect;
  intensity?: number;
  seconds?: number;
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
export function getMusicState(guildId: string): MusicState {
  if (!guildId) throw new Error('guildId is required');
  return musicManager.get(guildId)?.getState() ?? emptyMusicState();
}

/** Handle a POST /music command from the dashboard. */
export async function handleMusic(client: Client, body: MusicBody): Promise<Record<string, unknown>> {
  const guildId = (body.guildId ?? '').trim();
  if (!guildId) throw new Error('guildId is required');

  if (body.action === 'play') {
    const channelId = (body.channelId ?? '').trim();
    const query = (body.query ?? '').trim();
    if (!query) throw new Error('query is required');

    const channel = await resolveDashboardVoiceChannel(client, guildId, channelId, body.userId);

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
