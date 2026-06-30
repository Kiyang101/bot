/**
 * voiceStateMusic.ts — Auto-leave for the music player.
 *
 * A second VoiceStateUpdate listener (discord.js supports many) that stops the
 * guild's music session when the bot is left alone in its channel, or when the
 * bot itself is disconnected from voice. The existing voice-log handler in
 * voiceStateUpdate.ts is untouched.
 */

import { Events, type VoiceState } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import type { BotEvent } from '../types';
import { musicManager } from '../lib/music/musicSession';

const event: BotEvent = {
  name: Events.VoiceStateUpdate,
  async execute(oldState: VoiceState, newState: VoiceState) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const session = musicManager.get(guild.id);
    if (!session) return;

    const botId = guild.client.user.id;
    const memberId = newState.member?.id ?? oldState.member?.id;

    // The bot itself was disconnected/kicked from voice → stop.
    if (memberId === botId && oldState.channelId && !newState.channelId) {
      session.stop();
      return;
    }

    // Ignore the bot's OWN join/move. Otherwise the bot joining a channel where
    // nobody is sitting (e.g. a dashboard-initiated play) would immediately see
    // "0 humans" and stop itself before any audio plays.
    if (memberId === botId) return;

    // Only react when a real member actually changes channel (not mute/deafen).
    if (oldState.channelId === newState.channelId) return;

    const botChannelId = getVoiceConnection(guild.id)?.joinConfig.channelId;
    if (!botChannelId) return;

    // Only relevant when someone left/moved away FROM the bot's channel.
    if (oldState.channelId !== botChannelId) return;

    const channel = guild.channels.cache.get(botChannelId);
    if (!channel || !channel.isVoiceBased()) return;

    // Are any non-bot members still in the bot's channel?
    const humans = channel.members.filter((m) => !m.user.bot).size;
    if (humans === 0) {
      console.log(`[music] everyone left ${channel.name} — leaving guild ${guild.id}`);
      session.stop();
    }
  },
};

export default event;
