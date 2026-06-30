'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { selectGuild } from './actions';

interface Guild {
  id: string;
  name: string;
}

export default function GuildSwitcher({
  guilds,
  current,
}: {
  guilds: Guild[];
  current: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (guilds.length === 0) return null;

  function onChange(guildId: string) {
    startTransition(async () => {
      await selectGuild(guildId);
      router.refresh();
    });
  }

  return (
    <select
      className="guild-switcher"
      value={current}
      disabled={pending}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Select Discord server"
    >
      {guilds.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}
