/**
 * musicSession.ts — One music player per guild.
 *
 * Owns its own `AudioPlayer` and the guild's single `VoiceConnection`, drives a
 * track queue, and renders a now-playing message with control buttons. It is a
 * sibling of the TTS `SpeakSession` (src/lib/voiceAI/session.ts): both share the
 * one per-guild voice connection, coordinating through the ducking registry
 * (src/lib/voice/ducking.ts) so speech can interrupt music and resume it.
 */

import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  type VoiceConnection,
  type AudioPlayer,
  type AudioResource,
} from '@discordjs/voice';
import type { VoiceBasedChannel, GuildTextBasedChannel, Message } from 'discord.js';
import type { Track, LoopMode, MusicState, Effect } from './types';
import { EFFECTS, DEFAULT_INTENSITY } from './types';
import { createAudioStream, getStreamUrl, effectPlaybackRate, type AudioStream } from './ytdlp';
import { nowPlayingEmbed, controlComponents } from './ui';
import { registerDuckable, unregisterDuckable } from '../voice/ducking';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function clampIntensity(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

const DEFAULT_VOLUME = Math.min(100, Math.max(0, envInt('MUSIC_DEFAULT_VOLUME', 100)));
const IDLE_TIMEOUT_MS = envInt('MUSIC_IDLE_TIMEOUT_MS', 120_000);
const MAX_QUEUE = envInt('MUSIC_MAX_QUEUE', 100);

class MusicSession {
  private readonly guildId: string;
  private connection: VoiceConnection | null = null;
  private readonly player: AudioPlayer;
  private currentResource: AudioResource | null = null;

  private queue: Track[] = [];
  private current: Track | null = null;
  private loop: LoopMode = 'off';
  private effect: Effect = 'off';
  private intensity = DEFAULT_INTENSITY;
  private volume = DEFAULT_VOLUME;
  private currentStream: AudioStream | null = null;
  /** Direct media URL for the current track (resolved once, reused for seeks). */
  private currentUrl: string | null = null;
  /** Seconds the current ffmpeg stream was started at (the seek offset). */
  private seekBaseSec = 0;

  private voiceChannel: VoiceBasedChannel | null = null;
  private textChannel: GuildTextBasedChannel | null = null;
  private npMessage: Message | null = null;

  private idleTimer: NodeJS.Timeout | null = null;
  private leaving = false;

  constructor(guildId: string) {
    this.guildId = guildId;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    // Advance the queue whenever a track finishes (or errors out).
    this.player.on(AudioPlayerStatus.Idle, () => {
      // A track that "finishes" almost instantly never really played — usually
      // a failed download or an empty stream. Flag it so it's not a silent skip.
      const playedMs = this.currentResource?.playbackDuration ?? 0;
      if (this.current && playedMs < 500) {
        console.warn(`[music] "${this.current.title}" produced no audio (played ${playedMs}ms) — skipping.`);
      }
      if (!this.leaving) void this.advance();
    });
    this.player.on('error', (err) => {
      console.error(`[music] player error in guild ${this.guildId}:`, err.message);
      if (!this.leaving) void this.advance();
    });
  }

  // ---- Connection ---------------------------------------------------------

  private ensureConnection(channel: VoiceBasedChannel): VoiceConnection {
    const existing = getVoiceConnection(channel.guild.id);
    let connection: VoiceConnection;
    if (existing && existing.joinConfig.channelId === channel.id) {
      connection = existing;
    } else {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true, // we only output audio
      });
    }
    connection.subscribe(this.player);
    this.connection = connection;
    this.voiceChannel = channel;
    return connection;
  }

  // ---- Public API ---------------------------------------------------------

  /**
   * Add tracks and start playing if idle. Joins (or moves to) `voiceChannel`
   * and binds now-playing messages to `textChannel`. Returns whether playback
   * started immediately (vs. just queued).
   */
  async enqueue(
    voiceChannel: VoiceBasedChannel,
    textChannel: GuildTextBasedChannel | null,
    tracks: Track[],
  ): Promise<{ startedNow: boolean; added: number }> {
    this.leaving = false;
    // Keep any previously-bound text channel when called without one (e.g. from
    // the dashboard, which has no Discord text channel to post into).
    if (textChannel) this.textChannel = textChannel;
    this.clearIdleTimer();

    const room = Math.max(0, MAX_QUEUE - this.queue.length);
    const toAdd = tracks.slice(0, room);
    this.queue.push(...toAdd);

    const connection = this.ensureConnection(voiceChannel);
    registerDuckable(this.guildId, {
      pause: () => this.player.pause(),
      resume: () => {
        connection.subscribe(this.player);
        this.player.unpause();
      },
    });

    let startedNow = false;
    if (!this.current) {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      await this.advance();
      startedNow = true;
    }
    return { startedNow, added: toAdd.length };
  }

  /** Play the next track honoring the loop mode. Stops if the queue is empty. */
  private async advance(): Promise<void> {
    let next: Track | undefined;
    if (this.loop === 'track' && this.current) {
      next = this.current;
    } else {
      if (this.loop === 'queue' && this.current) this.queue.push(this.current);
      next = this.queue.shift();
    }

    if (!next) {
      this.current = null;
      this.currentResource = null;
      this.currentUrl = null;
      await this.refreshNowPlaying();
      this.startIdleTimer();
      return;
    }

    this.current = next;
    this.currentUrl = null; // force a fresh URL resolve for the new track
    console.log(`[music] ▶ playing "${next.title}" in guild ${this.guildId} (queue: ${this.queue.length})`);
    try {
      await this.startStream(next, 0);
    } catch (err) {
      console.error(`[music] failed to start "${next.title}":`, (err as Error).message);
      // Skip the unplayable track and move on.
      void this.advance();
      return;
    }
    await this.postNowPlaying();
  }

  /**
   * Build the (effect-filtered) stream for a track and start playing it at
   * `seekSec`. Resolves the direct URL on first use for the current track and
   * reuses it for subsequent seeks / effect changes.
   */
  private async startStream(track: Track, seekSec: number): Promise<void> {
    // Build the NEW stream first (URL resolution may await). We must NOT tear
    // down the currently-playing stream until the replacement is ready — doing
    // so makes the player go Idle mid-swap, which spuriously fires advance() and
    // drains the queue. The old stream is destroyed only after play() below.
    let audio: AudioStream;
    if (seekSec > 0) {
      // Seeking needs a direct, range-seekable URL (resolved once per track).
      if (!this.currentUrl) this.currentUrl = await getStreamUrl(track);
      audio = createAudioStream({
        url: this.currentUrl,
        effect: this.effect,
        intensity: this.intensity,
        volume: this.volume,
        seekSec,
      });
    } else {
      // Normal playback uses the robust yt-dlp pipe.
      audio = createAudioStream({
        track,
        effect: this.effect,
        intensity: this.intensity,
        volume: this.volume,
      });
    }

    const previous = this.currentStream;
    this.currentStream = audio;
    this.seekBaseSec = seekSec;
    // Ogg-Opus passthrough: ffmpeg encodes Opus (with 20 ms framing); @discordjs/
    // voice forwards packets straight to Discord — no per-frame PCM volume
    // transform or Opus encode on the main thread, so the send loop is the
    // lightest possible and most resistant to event-loop jitter. Volume is baked
    // into the ffmpeg filter chain instead of a live inline transformer.
    const resource = createAudioResource(audio.stream, {
      inputType: StreamType.OggOpus,
    });
    this.currentResource = resource;
    this.player.play(resource);
    // New resource is now playing — safe to kill the old stream's processes.
    previous?.destroy();
  }

  /**
   * Current playback position in seconds (seek offset + time played). Played
   * time is scaled by the effect's speed so the position reflects the *content*
   * position even under nightcore/vaporwave.
   */
  private positionSec(): number {
    const played = (this.currentResource?.playbackDuration ?? 0) / 1000;
    const pos = this.seekBaseSec + played * effectPlaybackRate(this.effect, this.intensity);
    const dur = this.current?.durationSec;
    return dur != null ? Math.min(pos, dur) : pos;
  }

  /**
   * Seek the current track to `targetSec`. Returns false if there's nothing
   * playing or the track has no known duration (e.g. a livestream).
   */
  async seek(targetSec: number): Promise<boolean> {
    if (!this.current || this.current.durationSec == null) return false;
    const pos = Math.min(this.current.durationSec, Math.max(0, targetSec));
    await this.startStream(this.current, pos);
    void this.refreshNowPlaying();
    return true;
  }

  /** Restart the current track at its present position (effect change). */
  private restartAtCurrentPosition(): void {
    const track = this.current;
    if (!track) return;
    const pos = this.positionSec();
    void this.startStream(track, pos)
      .then(() => this.refreshNowPlaying())
      .catch((err) => {
        // The seek path (direct URL) can be flaky — never let an effect change
        // silence playback. Fall back to the robust pipe from the start.
        console.error('[music] restart-at-position failed, restarting track:', (err as Error).message);
        this.currentUrl = null;
        void this.startStream(track, 0)
          .then(() => this.refreshNowPlaying())
          .catch((e) => console.error('[music] restart failed:', (e as Error).message));
      });
  }

  /** Skip the current track. Returns the skipped track, if any. */
  skip(): Track | null {
    const skipped = this.current;
    // loop:'track' would replay the same song on skip — temporarily bypass it.
    if (this.loop === 'track') {
      this.current = null;
    }
    this.player.stop(true); // → Idle → advance()
    return skipped;
  }

  /** Stop everything, clear the queue, and leave the channel. */
  stop(): void {
    this.leaving = true;
    this.queue = [];
    this.current = null;
    this.currentResource = null;
    this.currentStream?.destroy();
    this.currentStream = null;
    this.currentUrl = null;
    this.seekBaseSec = 0;
    this.loop = 'off';
    this.clearIdleTimer();
    this.player.stop(true);
    unregisterDuckable(this.guildId);
    getVoiceConnection(this.guildId)?.destroy();
    this.connection = null;
    void this.finalizeNowPlaying();
    manager.delete(this.guildId);
    console.log(`[music] stopped + left guild ${this.guildId}`);
  }

  pause(): boolean {
    const ok = this.player.pause();
    void this.refreshNowPlaying();
    return ok;
  }

  resume(): boolean {
    const ok = this.player.unpause();
    void this.refreshNowPlaying();
    return ok;
  }

  shuffle(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  /** Remove the track at 1-based queue position; returns it or null. */
  remove(position: number): Track | null {
    const idx = position - 1;
    if (idx < 0 || idx >= this.queue.length) return null;
    return this.queue.splice(idx, 1)[0];
  }

  /**
   * Jump to a queued track by 1-based position: move it to the front and skip
   * the current track so it plays now. Tracks that were ahead of it keep their
   * order and play afterwards. Returns the jumped-to track, or null if invalid.
   */
  jump(position: number): Track | null {
    const idx = position - 1;
    if (idx < 0 || idx >= this.queue.length) return null;
    const [track] = this.queue.splice(idx, 1);
    this.queue.unshift(track);
    this.skip(); // → Idle → advance() plays the moved track
    return track;
  }

  setVolume(volume: number): number {
    this.volume = Math.min(100, Math.max(0, Math.round(volume)));
    // Volume is baked into the ffmpeg filter chain (Opus passthrough has no live
    // PCM volume), so apply it by restarting the stream at the current position.
    this.restartAtCurrentPosition();
    return this.volume;
  }

  cycleLoop(): LoopMode {
    this.loop = this.loop === 'off' ? 'track' : this.loop === 'track' ? 'queue' : 'off';
    void this.refreshNowPlaying();
    return this.loop;
  }

  setLoop(mode: LoopMode): LoopMode {
    this.loop = mode;
    void this.refreshNowPlaying();
    return this.loop;
  }

  /**
   * Set the audio effect, optionally with an intensity (0–100). Without an
   * explicit intensity the effect resets to its default. If a track is playing
   * it restarts from the beginning with the new filter applied (seamless
   * seeking isn't practical here).
   */
  setEffect(effect: Effect, intensity?: number): Effect {
    this.effect = effect;
    this.intensity = clampIntensity(intensity ?? DEFAULT_INTENSITY);
    // Re-apply the filter without losing the listener's place in the track.
    this.restartAtCurrentPosition();
    return this.effect;
  }

  /** Adjust the intensity (0–100) of the active effect, keeping the position. */
  setIntensity(intensity: number): number {
    this.intensity = clampIntensity(intensity);
    if (this.effect !== 'off') {
      this.restartAtCurrentPosition();
    }
    return this.intensity;
  }

  /** Step to the next effect in the list (used by the cycle button). */
  cycleEffect(): Effect {
    const i = EFFECTS.indexOf(this.effect);
    return this.setEffect(EFFECTS[(i + 1) % EFFECTS.length]);
  }

  isPaused(): boolean {
    return (
      this.player.state.status === AudioPlayerStatus.Paused ||
      this.player.state.status === AudioPlayerStatus.AutoPaused
    );
  }

  hasNothingPlaying(): boolean {
    return this.current === null && this.queue.length === 0;
  }

  getState(): MusicState {
    return {
      current: this.current,
      queue: [...this.queue],
      loop: this.loop,
      effect: this.effect,
      intensity: this.intensity,
      volume: this.volume,
      positionSec: this.positionSec(),
      playbackRate: effectPlaybackRate(this.effect, this.intensity),
      paused: this.isPaused(),
      channelName: this.voiceChannel?.name ?? null,
    };
  }

  // ---- Now-playing message ------------------------------------------------

  private async postNowPlaying(): Promise<void> {
    if (!this.textChannel) return;
    const state = this.getState();
    const payload = { embeds: [nowPlayingEmbed(state)], components: controlComponents(state) };
    try {
      if (this.npMessage) {
        this.npMessage = await this.npMessage.edit(payload);
      } else {
        this.npMessage = await this.textChannel.send(payload);
      }
    } catch (err) {
      // Message may have been deleted — fall back to a fresh send next time.
      this.npMessage = null;
      console.error(`[music] now-playing post failed:`, (err as Error).message);
    }
  }

  /** Re-render the existing now-playing message in place (state changed). */
  private async refreshNowPlaying(): Promise<void> {
    if (!this.npMessage) return;
    const state = this.getState();
    try {
      this.npMessage = await this.npMessage.edit({
        embeds: [nowPlayingEmbed(state)],
        components: state.current ? controlComponents(state) : [],
      });
    } catch {
      this.npMessage = null;
    }
  }

  /** Strip the buttons off the last now-playing message when we leave. */
  private async finalizeNowPlaying(): Promise<void> {
    const msg = this.npMessage;
    this.npMessage = null;
    if (!msg) return;
    try {
      await msg.edit({ components: [] });
    } catch {
      /* message gone — nothing to do */
    }
  }

  // ---- Idle auto-leave ----------------------------------------------------

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.hasNothingPlaying()) {
        console.log(`[music] idle timeout — leaving guild ${this.guildId}`);
        this.stop();
      }
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/** One session per guild. */
const manager = new Map<string, MusicSession>();

export const musicManager = {
  /** Get the existing session for a guild, or null. */
  get(guildId: string): MusicSession | null {
    return manager.get(guildId) ?? null;
  },
  /** Get or create the session for a guild. */
  getOrCreate(guildId: string): MusicSession {
    let session = manager.get(guildId);
    if (!session) {
      session = new MusicSession(guildId);
      manager.set(guildId, session);
    }
    return session;
  },
};

export type { MusicSession };
