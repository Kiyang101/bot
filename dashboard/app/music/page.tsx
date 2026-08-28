import { listVoiceChannels } from "@/lib/discord";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { assertSupabaseResult } from "@/lib/database";
import { getSelectedGuildId } from "@/lib/guild";
import { getSessionUser } from "@/lib/session";
import { getMusicState, type MusicState } from "@/lib/control";
import type { MusicHistoryItem } from "../actions";
import MusicPlayer from "./MusicPlayer";

export const dynamic = "force-dynamic";

const EMPTY: MusicState = {
  current: null,
  queue: [],
  loop: "off",
  effect: "off",
  intensity: 50,
  volume: 80,
  positionSec: 0,
  playbackRate: 1,
  paused: false,
  channelId: null,
  channelName: null,
};

export default async function MusicPage() {
  const guildId = await getSelectedGuildId();
  const [channels, initialState] = await Promise.all([
    listVoiceChannels(guildId).catch(() => []),
    guildId
      ? getMusicState(guildId).catch(() => EMPTY)
      : Promise.resolve(EMPTY),
  ]);
  const user = await getSessionUser();
  const db = createClient(await cookies());
  const historyRows = guildId
    ? (assertSupabaseResult(
        "read MusicHistory",
        await db
          .from("MusicHistory")
          .select("*")
          .eq("guildId", guildId)
          .order("createdAt", { ascending: false })
          .limit(50),
      ) ?? [])
    : [];
  const initialHistory: MusicHistoryItem[] = historyRows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    durationSec: row.durationSec,
    thumbnail: row.thumbnail,
    uploader: row.uploader,
    createdAt: row.createdAt,
  }));

  return (
    <main className="music-page">
      <a className="back-button" href="/servers">← Select server</a>
      <h1>Music</h1>
      <p className="sub">
        Play YouTube audio in a voice channel and control the queue live.
      </p>

      <MusicPlayer
        channels={channels}
        initialState={initialState}
        initialHistory={initialHistory}
        isAdmin={user?.role === "admin"}
      />

      <p className="hint">
        {channels.length === 0
          ? "No voice channels found — check the bot token / that the bot is in the server."
          : "The bot joins the channel you pick. Search by name or paste a YouTube URL."}
      </p>
    </main>
  );
}
