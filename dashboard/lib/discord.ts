// Server-only helpers that call the Discord REST API with the bot token.
// Never import this into a client component — it would leak the token.
const TOKEN = process.env.DISCORD_TOKEN;
const API = 'https://discord.com/api/v10';

export interface TextChannel {
  id: string;
  name: string;
}

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
}

async function discordFetch<T>(path: string): Promise<T> {
  if (!TOKEN) throw new Error('DISCORD_TOKEN is not set');
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${TOKEN}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Lists every server the bot is a member of (for the server selection page). */
export async function listGuilds(): Promise<Guild[]> {
  const guilds = await discordFetch<Array<{ id: string; name: string; icon: string | null }>>(
    `/users/@me/guilds`,
  );
  return guilds
    .map((g) => ({ id: g.id, name: g.name, icon: g.icon }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return guilds where the verified Discord user is a member and the bot is
 * also present. A selected-guild cookie is intentionally not consulted here.
 */
export async function listAuthorizedGuilds(discordUserId: string): Promise<Guild[]> {
  const guilds = await listGuilds();
  const membership = await Promise.all(guilds.map(async (guild) => {
    const res = await fetch(`${API}/guilds/${encodeURIComponent(guild.id)}/members/${encodeURIComponent(discordUserId)}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
      cache: 'no-store',
    });
    return res.ok;
  }));
  return guilds.filter((_guild, index) => membership[index]);
}

/** Lists the server's text channels (type 0), for the settings dropdown. */
export async function listTextChannels(guildId: string | null): Promise<TextChannel[]> {
  if (!guildId) return [];
  const channels = await discordFetch<Array<{ id: string; name: string; type: number }>>(
    `/guilds/${guildId}/channels`,
  );
  return channels
    .filter((c) => c.type === 0)
    .map((c) => ({ id: c.id, name: c.name }));
}

/** Lists the server's voice channels (type 2), for the "speak" page. */
export async function listVoiceChannels(guildId: string | null): Promise<TextChannel[]> {
  if (!guildId) return [];
  const channels = await discordFetch<Array<{ id: string; name: string; type: number }>>(
    `/guilds/${guildId}/channels`,
  );
  return channels
    .filter((c) => c.type === 2)
    .map((c) => ({ id: c.id, name: c.name }));
}

/** Validate a client-supplied voice channel against the bot's guild channel list. */
export async function isVoiceChannelInGuild(guildId: string, channelId: string): Promise<boolean> {
  return (await listVoiceChannels(guildId)).some((channel) => channel.id === channelId);
}

/** Basic info about the given server. */
export async function getGuildInfo(
  guildId: string | null,
): Promise<{ id: string; name: string; memberCount?: number } | null> {
  if (!guildId) return null;
  const g = await discordFetch<{ id: string; name: string; approximate_member_count?: number }>(
    `/guilds/${guildId}?with_counts=true`,
  );
  return { id: g.id, name: g.name, memberCount: g.approximate_member_count };
}
