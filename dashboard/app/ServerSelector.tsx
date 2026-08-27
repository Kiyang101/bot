'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { selectGuild } from './actions';

interface Guild {
  id: string;
  name: string;
  icon: string | null;
}

export default function ServerSelector({
  guilds,
  current,
  destination,
}: {
  guilds: Guild[];
  current: string;
  destination: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function chooseServer(guildId: string) {
    startTransition(async () => {
      await selectGuild(guildId);
      router.push(destination);
    });
  }

  return (
    <div className="server-grid" aria-label="Discord servers">
      {guilds.map((guild) => {
        const iconUrl = guild.icon
          ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${guild.icon.startsWith('a_') ? 'gif' : 'png'}?size=128`
          : null;

        return (
          <button
            key={guild.id}
            type="button"
            className={`server-card${guild.id === current ? ' selected' : ''}`}
            disabled={pending}
            onClick={() => chooseServer(guild.id)}
          >
            {iconUrl ? (
              <img className="server-icon" src={iconUrl} alt={`${guild.name} logo`} />
            ) : (
              <span className="server-icon server-icon-placeholder" aria-hidden="true">
                {guild.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="server-card-info">
              <span className="server-card-name">{guild.name}</span>
              {guild.id === current && <span className="server-card-current">Currently selected</span>}
            </span>
            <span className="server-card-arrow" aria-hidden="true">→</span>
          </button>
        );
      })}
    </div>
  );
}
