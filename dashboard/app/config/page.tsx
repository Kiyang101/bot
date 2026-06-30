import { listTextChannels } from '@/lib/discord';
import { prisma } from '@/lib/prisma';
import { getSelectedGuildId } from '@/lib/guild';
import { saveLogChannel } from '../actions';

export const dynamic = 'force-dynamic';

export default async function ConfigPage() {
  const guildId = await getSelectedGuildId();

  const [channels, config] = await Promise.all([
    listTextChannels(guildId).catch(() => []),
    guildId ? prisma.guildConfig.findUnique({ where: { guildId } }) : Promise.resolve(null),
  ]);

  const current = config?.logChannelId ?? '';

  return (
    <main>
      <h1>Settings</h1>
      <p className="sub">Choose which text channel voice activity gets posted to in Discord.</p>

      <form action={saveLogChannel}>
        <label htmlFor="channelId">Voice log channel</label>
        <select id="channelId" name="channelId" defaultValue={current}>
          <option value="">— Disabled —</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
        <button type="submit">Save</button>
        <p className="hint">
          {channels.length === 0
            ? 'Could not load channels — make sure the bot token is valid and the bot is in the server.'
            : `${channels.length} text channels available. "Disabled" stops posting (events are still recorded).`}
        </p>
      </form>
    </main>
  );
}
