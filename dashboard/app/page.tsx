import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { assertSupabaseResult } from '@/lib/database';
import { getGuildInfo } from '@/lib/discord';
import { getSelectedGuildId } from '@/lib/guild';
import { readBotRuntime } from '@/lib/runtime';
import BotControl from './BotControl';

// Always render fresh (this is a live dashboard, not a static page).
export const dynamic = 'force-dynamic';

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function LogsPage() {
  const guildId = await getSelectedGuildId();

  const db = createClient(await cookies());
  let eventsQuery = db.from('VoiceEvent').select('*', { count: 'exact' }).order('createdAt', { ascending: false }).limit(100);
  if (guildId) eventsQuery = eventsQuery.eq('guildId', guildId);
  const [eventsResult, guild, runtime] = await Promise.all([
    eventsQuery,
    getGuildInfo(guildId).catch(() => null),
    readBotRuntime().catch(() => null),
  ]);
  const events = (assertSupabaseResult('read VoiceEvent', eventsResult) ?? []).map((event) => ({
    ...event,
    createdAt: new Date(event.createdAt),
  }));
  const total = eventsResult.count ?? 0;

  return (
    <main>
      <h1>Voice Activity</h1>
      <p className="sub">{guild ? `Server: ${guild.name}` : 'Recent voice channel activity'}</p>

      <BotControl runtime={runtime} />

      <div className="cards">
        <div className="card">
          <div className="num">{total}</div>
          <div className="lbl">Total events</div>
        </div>
        <div className="card">
          <div className="num">{guild?.memberCount ?? '—'}</div>
          <div className="lbl">Members</div>
        </div>
        <div className="card">
          <div className="num">{events.length}</div>
          <div className="lbl">Showing latest</div>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="empty">
          No voice activity yet. Join a voice channel in your server (with the bot
          running) and events will appear here.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Action</th>
              <th>Channel</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{e.username}</td>
                <td>
                  <span className={`badge ${e.action.toLowerCase()}`}>{e.action}</span>
                </td>
                <td>
                  {e.action === 'MOVE'
                    ? `${e.fromChannelName ?? '?'} → ${e.channelName ?? '?'}`
                    : e.channelName ?? '—'}
                </td>
                <td>{timeAgo(e.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
