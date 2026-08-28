import { listVoiceChannels, getGuildInfo } from '@/lib/discord';
import { readBotRuntime } from '@/lib/runtime';
import { getMusicState, type MusicState } from '@/lib/control';
import { listSoundboardData } from './actions';

const EMPTY_MUSIC_STATE: MusicState = {
  current: null,
  queue: [],
  loop: 'off',
  effect: 'off',
  intensity: 50,
  volume: 80,
  positionSec: 0,
  playbackRate: 1,
  paused: false,
  channelId: null,
  channelName: null,
};

export async function loadSoundboardPageData() {
  const board = await listSoundboardData();
  const guildId = board.selectedGuildId;
  const [guild, channels, musicState, runtime] = await Promise.all([
    getGuildInfo(guildId).catch(() => null),
    listVoiceChannels(guildId).catch(() => []),
    guildId ? getMusicState(guildId).catch(() => EMPTY_MUSIC_STATE) : Promise.resolve(EMPTY_MUSIC_STATE),
    readBotRuntime().catch(() => null),
  ]);

  return {
    ...board,
    guildName: guild?.name ?? (guildId ? 'Selected server' : null),
    channels,
    musicState,
    botStatus: runtime?.status ?? 'STOPPED' as const,
  };
}
