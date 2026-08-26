import { listVoiceChannels } from '@/lib/discord';
import { prisma } from '@/lib/prisma';
import { getSelectedGuildId } from '@/lib/guild';
import { getMusicState, type MusicState } from '@/lib/control';
import type { MusicHistoryItem } from '../actions';
import MusicPlayer from './MusicPlayer';

export const dynamic = 'force-dynamic';

const EMPTY: MusicState = {
  current: null,
  queue: [],
  loop: 'off',
  effect: 'off',
  intensity: 50,
  volume: 50,
  positionSec: 0,
  playbackRate: 1,
  paused: false,
  channelName: null,
};

export default async function MusicPage() {
  const guildId = await getSelectedGuildId();
  const [channels, initialState] = await Promise.all([
    listVoiceChannels(guildId).catch(() => []),
    guildId ? getMusicState(guildId).catch(() => EMPTY) : Promise.resolve(EMPTY),
  ]);
  const historyRows = guildId
    ? await prisma.musicHistory.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
    : [];
  const initialHistory: MusicHistoryItem[] = historyRows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    durationSec: row.durationSec,
    thumbnail: row.thumbnail,
    uploader: row.uploader,
    createdAt: row.createdAt.toISOString(),
  }));

  return (
    <main className="music-page">
      <h1>Music</h1>
      <p className="sub">Play YouTube audio or Spotify links in a voice channel and control the queue live.</p>

      <MusicPlayer channels={channels} initialState={initialState} initialHistory={initialHistory} />

      <p className="hint">
        {channels.length === 0
          ? 'No voice channels found — check the bot token / that the bot is in the server.'
          : 'The bot joins the channel you pick. Search by name, paste a YouTube/Spotify URL, or enter liked for Spotify Liked Songs.'}
      </p>
    </main>
  );
}
