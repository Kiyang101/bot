import { Events, EmbedBuilder, type VoiceState } from 'discord.js';
import { VoiceAction } from '../lib/database';
import type { BotEvent } from '../types';
import * as store from '../lib/voiceLogStore';

const event: BotEvent = {
  name: Events.VoiceStateUpdate,
  async execute(oldState: VoiceState, newState: VoiceState) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // Same channel = mute/deafen/stream toggle, not a join/leave/move. Ignore.
    if (oldChannelId === newChannelId) return;

    const member = newState.member ?? oldState.member;
    const who = member ? `${member}` : 'A user';
    const username = member?.displayName ?? 'Unknown';
    const userId = member?.id ?? 'unknown';
    const oldChannelName = oldState.channel?.name ?? null;
    const newChannelName = newState.channel?.name ?? null;

    let action: VoiceAction;
    let description: string;
    let color: number;
    if (!oldChannelId && newChannelId) {
      action = VoiceAction.JOIN;
      description = `📥 ${who} **joined** voice channel <#${newChannelId}>`;
      color = 0x57f287; // green
    } else if (oldChannelId && !newChannelId) {
      action = VoiceAction.LEAVE;
      description = `📤 ${who} **left** voice channel <#${oldChannelId}>`;
      color = 0xed4245; // red
    } else {
      action = VoiceAction.MOVE;
      description = `🔀 ${who} **moved** from <#${oldChannelId}> to <#${newChannelId}>`;
      color = 0x5865f2; // blurple
    }

    // 1) Always record to the database, so the dashboard has a full history.
    try {
      await store.recordVoiceEvent({
        guildId: guild.id,
        userId,
        username,
        action,
        channelId: action === VoiceAction.LEAVE ? oldChannelId : newChannelId,
        channelName: action === VoiceAction.LEAVE ? oldChannelName : newChannelName,
        fromChannelId: action === VoiceAction.MOVE ? oldChannelId : null,
        fromChannelName: action === VoiceAction.MOVE ? oldChannelName : null,
      });
    } catch (err) {
      console.error('Failed to save voice event:', (err as Error).message);
    }

    // 2) Post to the configured log channel, if this server set one up.
    let logChannelId: string | null = null;
    try {
      logChannelId = await store.getLogChannel(guild.id);
    } catch (err) {
      console.error('Failed to read voice-log config:', (err as Error).message);
      return;
    }
    if (!logChannelId) return;

    const logChannel =
      guild.channels.cache.get(logChannelId) ??
      (await guild.channels.fetch(logChannelId).catch(() => null));
    if (!logChannel || !logChannel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setDescription(description)
      .setTimestamp();

    await logChannel
      .send({ embeds: [embed] })
      .catch((err: Error) => console.error('Failed to send voice log:', err.message));
  },
};

export default event;
