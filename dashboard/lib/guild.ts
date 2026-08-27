// Resolves which Discord server the dashboard is currently viewing.
// Normally the selection is stored in a cookie (set by the server selection page), and
// falls back to the GUILD_ID env var so single-server setups keep working.
// Remote (ngrok) visitors are instead locked to REMOTE_GUILD_ID when it's set.
import { cookies, headers } from 'next/headers';
import {
  forcedGuildId,
  dashboardLinkGuildId,
  requestHost,
  GUILD_COOKIE,
  DASHBOARD_LINK_GUILD_COOKIE,
} from '@/lib/auth';

// Re-exported so existing importers (actions, layout) keep using '@/lib/guild'.
export { GUILD_COOKIE };

/**
 * The guild this request is *locked* to and may not switch away from — either a
 * remote (ngrok) visitor forced to REMOTE_GUILD_ID, or a dashboard link locked
 * to the server in its link. Null when the user is free to switch.
 */
export async function lockedGuildId(): Promise<string | null> {
  // An explicit per-server dashboard link wins over the static REMOTE_GUILD_ID
  // default, so each server's link opens that server.
  const store = await cookies();
  const fromLink = dashboardLinkGuildId(store.get(DASHBOARD_LINK_GUILD_COOKIE)?.value);
  if (fromLink) return fromLink;

  const hdrs = await headers();
  return forcedGuildId(requestHost((n) => hdrs.get(n)));
}

/** The currently selected guild id, or null if none is set anywhere. */
export async function getSelectedGuildId(): Promise<string | null> {
  const locked = await lockedGuildId();
  if (locked) return locked;

  const store = await cookies();
  const fromCookie = store.get(GUILD_COOKIE)?.value;
  if (fromCookie) return fromCookie;
  return process.env.GUILD_ID ?? null;
}
