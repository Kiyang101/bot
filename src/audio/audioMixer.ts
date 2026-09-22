import { Readable } from 'node:stream';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_RATE = 50;
const FRAME_MS = 1_000 / FRAME_RATE;
const SAMPLE_FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;
const SOURCE_HIGH_WATER_BYTES = 2 * 1024 * 1024;
const SOURCE_LOW_WATER_BYTES = 1024 * 1024;

export const PCM_FRAME_BYTES = (SAMPLE_RATE / FRAME_RATE) * SAMPLE_FRAME_BYTES;

export interface OverlayOptions {
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}

type SourceSlot = 'main' | 'overlay';

interface BufferedSource {
  stream: Readable;
  chunks: Buffer[];
  chunkOffset: number;
  bufferedBytes: number;
  ended: boolean;
  playedSampleFrames: number;
  pausedByBackpressure: boolean;
  pausedForPlayback: boolean;
  options?: OverlayOptions;
  onData: (chunk: Buffer | Uint8Array | string) => void;
  onEnd: () => void;
  onClose: () => void;
  onError: (error: Error) => void;
}

interface SourceFrame {
  audio: Buffer;
  remainingSampleFrames: number;
  playedSampleFrames: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A real-time 48 kHz stereo PCM source with one music slot and one one-shot
 * overlay slot. It remains readable as silence so Discord keeps one permanent
 * AudioResource for the lifetime of the guild session.
 */
export class AudioMixer extends Readable {
  private main: BufferedSource | null = null;
  private overlay: BufferedSource | null = null;
  private timer: NodeJS.Timeout | null = null;
  private mainPlayedSampleFrames = 0;

  constructor() {
    super({ highWaterMark: PCM_FRAME_BYTES * 4 });
  }

  setMain(stream: Readable): void {
    this.clearMain();
    this.mainPlayedSampleFrames = 0;
    this.main = this.attachSource('main', stream);
  }

  clearMain(): void {
    const source = this.main;
    if (!source) return;
    this.main = null;
    this.detachSource(source, true);
    this.mainPlayedSampleFrames = 0;
  }

  /** Pause only music consumption while the mixer continues serving overlays. */
  pauseMain(): boolean {
    const source = this.main;
    if (!source || source.pausedForPlayback) return false;
    source.pausedForPlayback = true;
    source.stream.pause();
    return true;
  }

  /** Resume a main source paused through {@link pauseMain}. */
  resumeMain(): boolean {
    const source = this.main;
    if (!source || !source.pausedForPlayback) return false;
    source.pausedForPlayback = false;
    if (!source.pausedByBackpressure) source.stream.resume();
    return true;
  }

  get isMainPaused(): boolean {
    return this.main?.pausedForPlayback ?? false;
  }

  /** Main-source audio consumed by the mixer, excluding generated silence. */
  get mainPlaybackDurationMs(): number {
    return (this.mainPlayedSampleFrames / SAMPLE_RATE) * 1_000;
  }

  startOverlay(stream: Readable, options: OverlayOptions): boolean {
    if (this.overlay) return false;
    this.overlay = this.attachSource('overlay', stream, {
      gainDb: finiteOr(options.gainDb, 0),
      fadeInMs: Math.max(0, finiteOr(options.fadeInMs, 0)),
      fadeOutMs: Math.max(0, finiteOr(options.fadeOutMs, 0)),
    });
    return true;
  }

  stopOverlay(): void {
    const source = this.overlay;
    if (!source) return;
    this.overlay = null;
    this.detachSource(source, true);
    this.emit('overlayEnded');
  }

  override _read(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pushFrame(), FRAME_MS);
    this.timer.unref();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const main = this.main;
    const overlay = this.overlay;
    this.main = null;
    this.overlay = null;
    if (main) this.detachSource(main, true);
    if (overlay) this.detachSource(overlay, true);
    callback(error);
  }

  private attachSource(
    slot: SourceSlot,
    stream: Readable,
    options?: OverlayOptions,
  ): BufferedSource {
    const source = {} as BufferedSource;
    source.stream = stream;
    source.chunks = [];
    source.chunkOffset = 0;
    source.bufferedBytes = 0;
    source.ended = false;
    source.playedSampleFrames = 0;
    source.pausedByBackpressure = false;
    source.pausedForPlayback = false;
    source.options = options;
    source.onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length === 0) return;
      source.chunks.push(buffer);
      source.bufferedBytes += buffer.length;
      if (source.bufferedBytes >= SOURCE_HIGH_WATER_BYTES && !source.pausedByBackpressure) {
        source.pausedByBackpressure = true;
        if (!stream.isPaused()) stream.pause();
      }
    };
    source.onEnd = () => {
      source.ended = true;
      if (source.bufferedBytes === 0) this.finishSource(slot, source);
    };
    source.onError = (error) => {
      source.ended = true;
      this.emit(`${slot}Error`, error);
      if (source.bufferedBytes === 0) this.finishSource(slot, source);
    };
    source.onClose = () => {
      if (!source.ended) source.onEnd();
    };
    stream.on('data', source.onData);
    stream.once('end', source.onEnd);
    stream.once('close', source.onClose);
    stream.once('error', source.onError);
    return source;
  }

  private detachSource(source: BufferedSource, destroy: boolean): void {
    source.stream.off('data', source.onData);
    source.stream.off('end', source.onEnd);
    source.stream.off('close', source.onClose);
    source.stream.off('error', source.onError);
    if (destroy && !source.stream.destroyed) source.stream.destroy();
    source.chunks = [];
    source.bufferedBytes = 0;
  }

  private finishSource(slot: SourceSlot, source: BufferedSource): void {
    if (this[slot] !== source) return;
    this[slot] = null;
    this.detachSource(source, false);
    this.emit(slot === 'main' ? 'mainEnded' : 'overlayEnded');
  }

  private pushFrame(): void {
    if (this.destroyed || this.readableLength + PCM_FRAME_BYTES > this.readableHighWaterMark) {
      return;
    }

    const main = this.takeSourceFrame('main', this.main, 0);
    const overlaySource = this.overlay;
    const fadeOutSampleFrames = overlaySource?.options
      ? Math.round((overlaySource.options.fadeOutMs / 1_000) * SAMPLE_RATE)
      : 0;
    const overlay = this.takeSourceFrame('overlay', overlaySource, fadeOutSampleFrames);
    const mixed = Buffer.allocUnsafe(PCM_FRAME_BYTES);
    const overlayOptions = overlaySource?.options;
    const gain = overlayOptions ? 10 ** (overlayOptions.gainDb / 20) : 1;
    const fadeInSampleFrames = overlayOptions
      ? Math.round((overlayOptions.fadeInMs / 1_000) * SAMPLE_RATE)
      : 0;

    for (let offset = 0; offset < PCM_FRAME_BYTES; offset += BYTES_PER_SAMPLE) {
      const mainSample = main?.audio.readInt16LE(offset) ?? 0;
      let overlaySample = overlay?.audio.readInt16LE(offset) ?? 0;
      if (overlay && overlayOptions) {
        const frameOffset = Math.floor(offset / SAMPLE_FRAME_BYTES);
        const fadeIn = fadeInSampleFrames > 0
          ? Math.min(1, (overlay.playedSampleFrames + frameOffset) / fadeInSampleFrames)
          : 1;
        const fadeOut = fadeOutSampleFrames > 0 && overlaySource?.ended
          ? Math.min(1, (overlay.remainingSampleFrames - frameOffset) / fadeOutSampleFrames)
          : 1;
        overlaySample = Math.round(overlaySample * gain * Math.max(0, Math.min(fadeIn, fadeOut)));
      }
      const sample = Math.max(-32_768, Math.min(32_767, mainSample + overlaySample));
      mixed.writeInt16LE(sample, offset);
    }
    this.push(mixed);
  }

  private takeSourceFrame(
    slot: SourceSlot,
    source: BufferedSource | null,
    reserveSampleFrames: number,
  ): SourceFrame | null {
    if (!source || this[slot] !== source) return null;
    if (source.pausedForPlayback) return null;
    const reserveBytes = reserveSampleFrames * SAMPLE_FRAME_BYTES;
    if (!source.ended && source.bufferedBytes < PCM_FRAME_BYTES + reserveBytes) return null;
    if (source.ended && source.bufferedBytes === 0) {
      this.finishSource(slot, source);
      return null;
    }

    const remainingSampleFrames = Math.ceil(source.bufferedBytes / SAMPLE_FRAME_BYTES);
    const playedSampleFrames = source.playedSampleFrames;
    const audio = this.consume(source, PCM_FRAME_BYTES);
    const consumedSampleFrames = Math.ceil(audio.length / SAMPLE_FRAME_BYTES);
    source.playedSampleFrames += consumedSampleFrames;
    if (slot === 'main') this.mainPlayedSampleFrames += consumedSampleFrames;
    const frame = audio.length === PCM_FRAME_BYTES
      ? audio
      : Buffer.concat([audio, Buffer.alloc(PCM_FRAME_BYTES - audio.length)], PCM_FRAME_BYTES);
    if (source.ended && source.bufferedBytes === 0) this.finishSource(slot, source);
    return { audio: frame, remainingSampleFrames, playedSampleFrames };
  }

  private consume(source: BufferedSource, limit: number): Buffer {
    const output = Buffer.allocUnsafe(Math.min(limit, source.bufferedBytes));
    let written = 0;
    while (written < output.length) {
      const chunk = source.chunks[0];
      const available = chunk.length - source.chunkOffset;
      const take = Math.min(available, output.length - written);
      chunk.copy(output, written, source.chunkOffset, source.chunkOffset + take);
      written += take;
      source.chunkOffset += take;
      source.bufferedBytes -= take;
      if (source.chunkOffset === chunk.length) {
        source.chunks.shift();
        source.chunkOffset = 0;
      }
    }
    if (
      source.pausedByBackpressure
      && !source.ended
      && source.bufferedBytes <= SOURCE_LOW_WATER_BYTES
    ) {
      source.pausedByBackpressure = false;
      if (!source.pausedForPlayback) source.stream.resume();
    }
    return output;
  }
}
