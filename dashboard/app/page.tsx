import { prisma } from '@/lib/prisma';
import { getGuildInfo } from '@/lib/discord';
import { getSelectedGuildId } from '@/lib/guild';

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
  const where = guildId ? { guildId } : undefined;

  const [events, total, guild] = await Promise.all([
    prisma.voiceEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.voiceEvent.count({ where }),
    getGuildInfo(guildId).catch(() => null),
  ]);

  return (
    <main>
      <h1>Voice Activity</h1>
      <p className="sub">{guild ? `Server: ${guild.name}` : 'Recent voice channel activity'}</p>

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
