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

const VIEW_CHANNEL = BigInt(1) << BigInt(10);
const CONNECT = BigInt(1) << BigInt(20);
const ADMINISTRATOR = BigInt(1) << BigInt(3);

interface DiscordRole {
  id: string;
  permissions: string;
}

interface DiscordMember {
  user?: { id: string };
  roles: string[];
}

interface DiscordPermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface DiscordVoiceChannel {
  id: string;
  guild_id?: string;
  type: number;
  permission_overwrites?: DiscordPermissionOverwrite[];
}

function permissionBits(value: string | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return BigInt(0);
  }
}

function canViewAndConnect(
  channel: DiscordVoiceChannel,
  member: DiscordMember,
  roles: DiscordRole[],
  guildId: string,
  memberId: string,
): boolean {
  const roleById = new Map(roles.map((role) => [role.id, role]));
  let permissions = permissionBits(roleById.get(guildId)?.permissions);
  for (const roleId of member.roles) permissions |= permissionBits(roleById.get(roleId)?.permissions);
  if ((permissions & ADMINISTRATOR) !== BigInt(0)) return true;

  const overwrites = channel.permission_overwrites ?? [];
  const everyoneOverwrite = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyoneOverwrite) {
    permissions &= ~permissionBits(everyoneOverwrite.deny);
    permissions |= permissionBits(everyoneOverwrite.allow);
  }

  const memberRoleIds = new Set(member.roles);
  let roleDeny = BigInt(0);
  let roleAllow = BigInt(0);
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !memberRoleIds.has(overwrite.id)) continue;
    roleDeny |= permissionBits(overwrite.deny);
    roleAllow |= permissionBits(overwrite.allow);
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  // The member-specific overwrite wins over aggregate role overwrites.
  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === (member.user?.id ?? memberId));
  if (memberOverwrite) {
    permissions &= ~permissionBits(memberOverwrite.deny);
    permissions |= permissionBits(memberOverwrite.allow);
  }

  return (permissions & VIEW_CHANNEL) !== BigInt(0) && (permissions & CONNECT) !== BigInt(0);
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

/** Verify the requesting Discord member can both view and connect to a voice channel. */
export async function canMemberUseVoiceChannel(
  guildId: string,
  channelId: string,
  discordUserId: string,
): Promise<boolean> {
  if (!guildId || !channelId || !discordUserId) return false;
  try {
    const [channel, member, roles] = await Promise.all([
      discordFetch<DiscordVoiceChannel>(`/channels/${encodeURIComponent(channelId)}`),
      discordFetch<DiscordMember>(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}`),
      discordFetch<DiscordRole[]>(`/guilds/${encodeURIComponent(guildId)}/roles`),
    ]);
    return channel.guild_id === guildId
      && channel.type === 2
      && canViewAndConnect(channel, member, roles, guildId, discordUserId);
  } catch {
    // Permission checks fail closed if Discord is unavailable or the member is absent.
    return false;
  }
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
