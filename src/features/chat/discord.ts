import { getVoiceConnection } from '@discordjs/voice';
import type { Guild, VoiceBasedChannel } from 'discord.js';
import { voiceSession } from '../speech/session';
import { createLocalTTS } from '../speech/providers/local';

class VoiceUnavailable extends Error {}

/** Resolve from live gateway state, never from the member snapshot on an interaction. */
export function resolveChatVoice(guild: Guild, userId: string): VoiceBasedChannel {
  const channel = guild.voiceStates.cache.get(userId)?.channel;
  if (!channel) throw new VoiceUnavailable('คุณออกจากห้องเสียงแล้ว จึงตอบเฉพาะข้อความ');
  const botChannels = [getVoiceConnection(guild.id)?.joinConfig.channelId, guild.members.me?.voice.channelId];
  if (botChannels.some((botChannel) => botChannel && botChannel !== channel.id)) {
    throw new VoiceUnavailable('บอตอยู่ในห้องเสียงอื่น จึงตอบเฉพาะข้อความและจะไม่ย้ายห้องอัตโนมัติ');
  }
  return channel;
}

export function chatSpeaker(guild: Guild, userId: string, reply: (text: string) => Promise<void>) {
  return async (text: string): Promise<void> => {
    // Text-only is normal when the user has no voice channel at reply time.
    if (!guild.voiceStates.cache.get(userId)?.channel) return;
    try {
      const channel = resolveChatVoice(guild, userId);
      await voiceSession.speak(channel, text, undefined, createLocalTTS(), () => resolveChatVoice(guild, userId));
    } catch (err) {
      if (err instanceof VoiceUnavailable) await reply(err.message);
      else throw err;
    }
  };
}
