// Resolves which Discord server the dashboard is currently viewing.
// Normally the selection is stored in a cookie (set by the GuildSwitcher), and
// falls back to the GUILD_ID env var so single-server setups keep working.
// Remote (ngrok) visitors are instead locked to GUEST_GUILD_ID when it's set.
import { cookies, headers } from 'next/headers';
import { forcedGuildId, requestHost } from '@/lib/auth';

export const GUILD_COOKIE = 'guildId';

/** The currently selected guild id, or null if none is set anywhere. */
export async function getSelectedGuildId(): Promise<string | null> {
  const hdrs = await headers();
  const forced = forcedGuildId(requestHost((n) => hdrs.get(n)));
  if (forced) return forced;

  const store = await cookies();
  const fromCookie = store.get(GUILD_COOKIE)?.value;
  if (fromCookie) return fromCookie;
  return process.env.GUILD_ID ?? null;
}
