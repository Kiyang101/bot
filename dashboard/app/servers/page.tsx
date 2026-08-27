import { listGuilds } from '@/lib/discord';
import { getSelectedGuildId, lockedGuildId } from '@/lib/guild';
import ServerSelector from '../ServerSelector';

export const dynamic = 'force-dynamic';

export default async function ServersPage() {
  const [guilds, current, locked] = await Promise.all([
    listGuilds().catch(() => []),
    getSelectedGuildId(),
    lockedGuildId(),
  ]);
  const visibleGuilds = locked ? guilds.filter((guild) => guild.id === locked) : guilds;

  return (
    <main className="server-page">
      <div className="server-heading">
        <span className="server-heading-eyebrow">Megu Dashboard</span>
        <h1>Select a server</h1>
        <p className="sub">Choose the Discord server you want to manage.</p>
      </div>

      {visibleGuilds.length > 0 ? (
        <ServerSelector
          guilds={visibleGuilds}
          current={current ?? ''}
          destination="/music"
        />
      ) : (
        <div className="server-empty">
          No servers found. Make sure the bot is connected to at least one Discord server.
        </div>
      )}
    </main>
  );
}
