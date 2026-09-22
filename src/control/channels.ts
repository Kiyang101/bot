import type { Client, VoiceBasedChannel } from 'discord.js';

export async function resolveSoundboardChannel(
  client: Client,
  channelId: string,
  guildId: string,
): Promise<VoiceBasedChannel> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('channelId is not a voice channel the bot can see');
  }
  if (channel.guild?.id !== guildId) {
    throw new Error('channelId belongs to a different Discord server than guildId');
  }
  return channel as VoiceBasedChannel;
}

/** Resolve an explicit dashboard destination, or the dashboard user's live voice channel. */
export async function resolveDashboardVoiceChannel(
  client: Client,
  guildId: string,
  channelId: string | undefined,
  userId: string | undefined,
): Promise<VoiceBasedChannel> {
  const explicitId = channelId?.trim();
  if (explicitId) return resolveSoundboardChannel(client, explicitId, guildId);
  const memberId = userId?.trim();
  if (!memberId) throw new Error('channelId or userId is required');
  const guild = client.guilds.cache.get(guildId);
  const member = guild?.members.cache.get(memberId);
  // Voice states are available through GuildVoiceStates even when the member
  // itself is absent from the member cache (the bot has no GuildMembers intent).
  const currentChannel = guild?.voiceStates.cache.get(memberId)?.channel ?? member?.voice.channel;
  if (!currentChannel || !currentChannel.isVoiceBased()) {
    throw new Error('You must be in a voice channel to use automatic connection.');
  }
  return currentChannel as VoiceBasedChannel;
}
