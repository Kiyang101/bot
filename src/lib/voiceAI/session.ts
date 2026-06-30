/**
 * session.ts — Voice "speak" session manager.
 *
 * One SpeakSession per guild. The bot joins a voice channel and plays back
 * synthesized speech for text you send it. There is NO listening: the old
 * AI voice-chat pipeline (STT → brain → TTS with wake-word detection) has
 * been disabled. This module only does:
 *
 *   text → TTS → play
 *
 * Requests are QUEUED and played one at a time, so firing several messages in
 * quick succession plays them in order instead of cutting each other off.
 *
 * Because the bot never needs to hear anyone, it joins with selfDeaf: true.
 */

import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import type { VoiceBasedChannel } from 'discord.js';
import { synthesize } from './tts';
import type { TtsProvider } from './providers/types';
import { duck, resume as resumeMusic, isMusicActive } from '../voice/ducking';

/** One queued speak request. Resolves when this clip finishes playing. */
interface SpeakItem {
  channel: VoiceBasedChannel;
  text: string;
  voice?: string;
  tts?: TtsProvider;
  resolve: () => void;
  reject: (err: unknown) => void;
}

class SpeakSession {
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private queue: SpeakItem[] = [];
  private processing = false;

  /**
   * Ensure we have a live connection + player in the requested channel.
   * Joins the channel — or MOVES there if the bot is connected to a different
   * channel in the same guild — so picking a new channel actually takes effect.
   */
  private ensureConnection(channel: VoiceBasedChannel): VoiceConnection {
    const existing = getVoiceConnection(channel.guild.id);

    let connection: VoiceConnection;
    if (existing && existing.joinConfig.channelId === channel.id) {
      // Already in the right channel — reuse it.
      connection = existing;
    } else {
      // Not connected, or connected elsewhere. joinVoiceChannel reuses the
      // guild's connection and moves it when the channel id differs.
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true, // we only speak — no need to receive audio
      });

      if (!existing) {
        connection.on('stateChange', (oldState, newState) => {
          console.log(`[session] voice state: ${oldState.status} -> ${newState.status}`);
        });
        connection.on('error', (err) => {
          console.error('[session] voice connection error:', err);
        });
      }
    }

    // Make sure a player exists and is subscribed to the current connection.
    const playerWasMissing = !this.player;
    if (!this.player) {
      this.player = createAudioPlayer();
    }
    if (playerWasMissing || this.connection !== connection) {
      connection.subscribe(this.player);
    }

    this.connection = connection;
    return connection;
  }

  /**
   * Queue a message to be spoken. The bot joins `channel` (or moves there),
   * synthesizes `text`, and plays it once any earlier queued clips finish.
   * `voice` optionally overrides the configured default voice; `tts` optionally
   * forces a specific provider (e.g. VOICEVOX). The returned promise resolves
   * when THIS clip finishes playing, or rejects if it can't be played.
   */
  speak(
    channel: VoiceBasedChannel,
    text: string,
    voice?: string,
    tts?: TtsProvider,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ channel, text, voice, tts, resolve, reject });
      void this.processQueue();
    });
  }

  /** Drain the queue, playing one clip at a time. */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.playOne(item);
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Synthesize and play a single queued item, resolving when it finishes. */
  private async playOne(item: SpeakItem): Promise<void> {
    const guildId = item.channel.guild.id;

    // If music is playing in this guild, pause it so the speech is audible,
    // then resume it once we're done (handled in the finally below).
    duck(guildId);
    try {
      await this.playOneInner(item);
    } finally {
      resumeMusic(guildId);
    }
  }

  /** The actual synthesize-and-play work, wrapped by music ducking. */
  private async playOneInner(item: SpeakItem): Promise<void> {
    const connection = this.ensureConnection(item.channel);

    // Wait for the UDP handshake to finish before playing.
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const audio = item.tts
      ? await item.tts.synthesize(item.text, item.voice)
      : await synthesize(item.text, item.voice);
    if (audio.length === 0) {
      // With an explicit provider (e.g. /sayjp's VOICEVOX) the caller gives a
      // tailored hint; the default path points at the .env key.
      throw new Error(
        item.tts
          ? 'No audio was produced for that text.'
          : 'TTS returned no audio — check your AI_TTS_PROVIDER key in .env.',
      );
    }

    const player = this.player!;
    const resource = createAudioResource(Readable.from(audio), {
      inputType: StreamType.Arbitrary,
    });

    // Attach the finish/error listeners BEFORE play() so we never miss the
    // transition for very short clips.
    const finished = new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        player.off(AudioPlayerStatus.Idle, onIdle);
        player.off('error', onError);
      };
      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once('error', onError);
    });

    player.play(resource);
    console.log(`[session] speaking ${audio.length} bytes in guild ${item.channel.guild.id}`);
    await finished;
  }

  /** Leave the voice channel for a guild and drop any queued messages. */
  leave(guildId: string): void {
    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.reject(new Error('Bot left the voice channel before this could play.'));
    }
    // If music is using the connection, only drop our TTS player — don't tear
    // down the shared connection out from under the music player.
    if (isMusicActive(guildId)) {
      this.player?.stop(true);
    } else {
      getVoiceConnection(guildId)?.destroy();
    }
    this.connection = null;
    this.player = null;
    this.processing = false;
    console.log(`[session] Left voice channel in guild ${guildId}`);
  }
}

/** One session per guild, keyed by guildId. */
const sessions = new Map<string, SpeakSession>();

/** Get or create the session for a guild. */
function getSession(guildId: string): SpeakSession {
  if (!sessions.has(guildId)) {
    sessions.set(guildId, new SpeakSession());
  }
  return sessions.get(guildId)!;
}

export const voiceSession = {
  speak(
    channel: VoiceBasedChannel,
    text: string,
    voice?: string,
    tts?: TtsProvider,
  ): Promise<void> {
    return getSession(channel.guild.id).speak(channel, text, voice, tts);
  },
  leave(guildId: string): void {
    getSession(guildId).leave(guildId);
    sessions.delete(guildId);
  },
};
