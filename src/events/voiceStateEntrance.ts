import { Events, ChannelType, type VoiceState } from 'discord.js';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import type { BotEvent } from '../types';
import { musicManager } from '../features/music/musicSession';
import { readEntrancePreference, resolveEntranceSound, resolveEntranceSpeech } from '../features/entrance/store';
import { EntranceService, entranceAudioBusy } from '../features/entrance/service';

const service = new EntranceService({
  now: Date.now,
  readyChannel: (guildId) => {
    const connection = getVoiceConnection(guildId);
    return connection?.state.status === VoiceConnectionStatus.Ready ? connection.joinConfig.channelId : null;
  },
  busy: entranceAudioBusy,
  preference: readEntrancePreference,
  sound: resolveEntranceSound,
  speech: resolveEntranceSpeech,
  play: (channel, sound, valid, deadline, owner) => musicManager.getOrCreate(channel.guild.id).playEntrance(channel, sound, valid, deadline, owner),
  cancel: (guildId) => musicManager.get(guildId)?.stopEntrance(),
});

const event: BotEvent = {
  name: Events.VoiceStateUpdate,
  execute(oldState: VoiceState, newState: VoiceState) {
    const member = newState.member;
    if (!member) return;
    void service.handle({
      guildId: newState.guild.id, userId: member.id, oldChannelId: oldState.channelId,
      channel: newState.channel, isBot: member.user.bot,
      isStage: newState.channel?.type === ChannelType.GuildStageVoice,
      currentChannelId: () => newState.guild.members.cache.get(member.id)?.voice.channelId ?? null,
    }).catch((error) => console.error('[entrance] event failed:', (error as Error).message));
  },
};
export default event;
