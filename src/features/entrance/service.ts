import type { VoiceBasedChannel } from 'discord.js';
import { audioBusy } from '../../audio/oneShotOwnership';
import { claimAudio, ownsAudio, releaseAudio, type AudioOwner } from '../../audio/oneShotOwnership';
import { ENTRANCE_MAX_AGE_MS, type EntrancePreference, type EntranceResult, type EntranceSound } from './types';

export interface EntranceEvent {
  guildId: string; userId: string; oldChannelId: string | null; channel: VoiceBasedChannel | null;
  isBot: boolean; isStage: boolean; currentChannelId: () => string | null;
}
export interface EntranceDependencies {
  now(): number;
  readyChannel(guildId: string): string | null;
  busy(guildId: string): boolean;
  preference(guildId: string, userId: string): Promise<EntrancePreference | null>;
  sound(soundId: string): Promise<EntranceSound | null>;
  speech?: (guildId: string, userId: string, preference: EntrancePreference) => Promise<EntranceSound | null>;
  play(channel: VoiceBasedChannel, sound: EntranceSound, valid: () => boolean, deadline: number, owner: AudioOwner): Promise<void>;
  cancel(guildId: string): void;
}

export class EntranceService {
  private readonly userUntil = new Map<string, number>();
  private readonly guildUntil = new Map<string, number>();
  private readonly preparing = new Set<string>();
  constructor(private readonly dependencies: EntranceDependencies) {}

  async handle(event: EntranceEvent): Promise<EntranceResult> {
    const d = this.dependencies;
    const channel = event.channel;
    const channelId = channel?.id;
    if (!channel || !channelId || event.oldChannelId === channelId || event.isBot || event.isStage || event.currentChannelId() !== channelId) return 'ineligible';
    if (d.readyChannel(event.guildId) !== channelId) return 'channel_changed';
    const now = d.now();
    for (const [key, until] of this.userUntil) if (until <= now) this.userUntil.delete(key);
    for (const [key, until] of this.guildUntil) if (until <= now) this.guildUntil.delete(key);
    const userKey = `${event.guildId}:${event.userId}`;
    if ((this.userUntil.get(userKey) ?? 0) > now || (this.guildUntil.get(event.guildId) ?? 0) > now) return 'cooldown';
    if (this.preparing.has(event.guildId) || d.busy(event.guildId)) return 'busy';
    let cancelled = false;
    const owner: AudioOwner = { kind: 'entrance', cancel: () => { cancelled = true; d.cancel(event.guildId); } };
    if (!claimAudio(event.guildId, owner)) return 'busy';
    this.userUntil.set(userKey, now + 60_000);
    this.guildUntil.set(event.guildId, now + 5_000);
    this.preparing.add(event.guildId);
    const deadline = now + ENTRANCE_MAX_AGE_MS;
    const valid = () => !cancelled && ownsAudio(event.guildId, owner) && d.now() <= deadline && event.currentChannelId() === channelId && d.readyChannel(event.guildId) === channelId;
    let timeout: NodeJS.Timeout | null = null;
    const expired = new Promise<'stale'>((resolve) => {
      timeout = setTimeout(() => { d.cancel(event.guildId); resolve('stale'); }, ENTRANCE_MAX_AGE_MS);
    });
    let result: EntranceResult = 'playback_failed';
    try {
      result = await Promise.race([this.perform(event, channel, channelId, deadline, valid, owner), expired]);
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      this.preparing.delete(event.guildId);
      if (result !== 'played') releaseAudio(event.guildId, owner);
    }
  }

  private async perform(event: EntranceEvent, channel: VoiceBasedChannel, channelId: string, deadline: number, valid: () => boolean, owner: AudioOwner): Promise<EntranceResult> {
    const d = this.dependencies;
    try {
      const preference = await d.preference(event.guildId, event.userId);
      if (!preference?.enabled || (preference.mode !== 'speech' && !preference.soundId)) return 'disabled';
      if (!valid()) return d.now() > deadline ? 'stale' : 'channel_changed';
      const sound = preference.mode === 'speech'
        ? await d.speech?.(event.guildId, event.userId, preference)
        : await d.sound(preference.soundId!);
      if (!sound) return 'sound_unavailable';
      if (!valid()) return d.now() > deadline ? 'stale' : 'channel_changed';
      if (!ownsAudio(event.guildId, owner)) return 'busy';
      await d.play(channel, sound, valid, deadline, owner);
      return 'played';
    } catch {
      return 'playback_failed';
    }
  }
}

export const entranceAudioBusy = audioBusy;
