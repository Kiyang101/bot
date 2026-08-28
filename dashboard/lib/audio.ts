import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { MAX_SOUND_BYTES, validateTrimRange, validateUploadMeta } from './sound-validation';

const AUDIO_PROCESSING_UNAVAILABLE = 'Audio processing is unavailable on this dashboard host.';
const INVALID_AUDIO_MESSAGE = 'The uploaded audio file could not be processed.';
const NORMALIZED_WAV_SAMPLE_RATE = 48_000;
const NORMALIZED_WAV_CHANNELS = 2;
const NORMALIZED_WAV_BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

type TrimSourceFileInput = {
  source: Buffer | Uint8Array;
  mimeType: string;
  trimStartMs: number;
  trimEndMs: number;
};

type ProcessResult = { exitCode: number | null; stderr: string };

const UNSUPPORTED_AUDIO_MESSAGE = 'Sound must be an MP3, WAV, or OGG file.';
const MPEG1_LAYER3_BITRATES_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;
const MPEG2_LAYER3_BITRATES_KBPS = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
] as const;
const MPEG_SAMPLE_RATES = {
  0b00: [11_025, 12_000, 8_000],
  0b10: [22_050, 24_000, 16_000],
  0b11: [44_100, 48_000, 32_000],
} as const;

function startsWithBytes(source: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => source[index] === byte);
}

function mpegFrameLength(source: Uint8Array, offset: number): number | null {
  if (offset < 0 || source.length - offset < 4 || source[offset] !== 0xff) return null;
  const version = (source[offset + 1] >> 3) & 0b11;
  const layer = (source[offset + 1] >> 1) & 0b11;
  const bitrateIndex = (source[offset + 2] >> 4) & 0b1111;
  const sampleRateIndex = (source[offset + 2] >> 2) & 0b11;
  const padding = (source[offset + 2] >> 1) & 0b1;
  const emphasis = source[offset + 3] & 0b11;
  if (
    (source[offset + 1] & 0b1110_0000) !== 0b1110_0000
    || version === 0b01
    || layer !== 0b01
    || bitrateIndex === 0
    || bitrateIndex === 0b1111
    || sampleRateIndex === 0b11
    || emphasis === 0b10
  ) {
    return null;
  }

  const sampleRates = MPEG_SAMPLE_RATES[version as keyof typeof MPEG_SAMPLE_RATES];
  const bitrates = version === 0b11 ? MPEG1_LAYER3_BITRATES_KBPS : MPEG2_LAYER3_BITRATES_KBPS;
  const sampleRate = sampleRates[sampleRateIndex];
  const bitrate = bitrates[bitrateIndex] * 1_000;
  const coefficient = version === 0b11 ? 144 : 72;
  const frameLength = Math.floor((coefficient * bitrate) / sampleRate) + padding;
  return frameLength >= 4 && source.length - offset >= frameLength ? frameLength : null;
}

function hasConsecutiveMp3Frames(source: Uint8Array, offset: number): boolean {
  const firstFrameLength = mpegFrameLength(source, offset);
  if (firstFrameLength === null) return false;

  // A lone plausible header plus zero-fill can satisfy a frame-size check. Requiring the
  // following frame at the calculated boundary prevents that fabricated payload from
  // crossing the format gate while remaining tolerant of normal MPEG frame variations.
  return mpegFrameLength(source, offset + firstFrameLength) !== null;
}

function id3AudioOffset(source: Uint8Array): number | null {
  if (!startsWithBytes(source, [0x49, 0x44, 0x33]) || source.length < 10) return null;
  const version = source[3];
  const revision = source[4];
  const flags = source[5];
  const reservedFlagsMask = version === 2 ? 0b0011_1111 : version === 3 ? 0b0001_1111 : 0b0000_1111;
  if (
    version < 2
    || version > 4
    || revision === 0xff
    || (flags & reservedFlagsMask) !== 0
    || source.subarray(6, 10).some((byte) => (byte & 0x80) !== 0)
  ) {
    return null;
  }

  const tagSize = source.subarray(6, 10).reduce((size, byte) => (size << 7) | byte, 0);
  const footerSize = version === 4 && (flags & 0b0001_0000) !== 0 ? 10 : 0;
  const audioOffset = 10 + tagSize + footerSize;
  return audioOffset <= source.length ? audioOffset : null;
}

/**
 * Identifies the supported source container from bytes supplied to the server.
 * The browser-provided MIME value is deliberately not used for this decision.
 */
export function detectSupportedAudioMimeType(source: Uint8Array): 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | null {
  if (startsWithBytes(source, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(source.subarray(8), [0x57, 0x41, 0x56, 0x45])) {
    return 'audio/wav';
  }
  if (startsWithBytes(source, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  const mp3Offset = startsWithBytes(source, [0x49, 0x44, 0x33]) ? id3AudioOffset(source) : 0;
  if (mp3Offset !== null && hasConsecutiveMp3Frames(source, mp3Offset)) return 'audio/mpeg';
  return null;
}

function bundledFfmpegPath(): string {
  if (!ffmpegPath) throw new Error(AUDIO_PROCESSING_UNAVAILABLE);
  return ffmpegPath;
}

function runFfmpeg(args: string[]): Promise<ProcessResult> {
  const command = bundledFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', () => reject(new Error(AUDIO_PROCESSING_UNAVAILABLE)));
    child.once('close', (exitCode) => resolve({ exitCode, stderr }));
  });
}

/** Returns the minimum byte count for the selected normalized PCM WAV duration. */
export function estimateNormalizedWavBytes(durationMs: number): number {
  const frameCount = Math.ceil((durationMs / 1_000) * NORMALIZED_WAV_SAMPLE_RATE);
  return WAV_HEADER_BYTES + frameCount * NORMALIZED_WAV_CHANNELS * NORMALIZED_WAV_BYTES_PER_SAMPLE;
}

function parseDurationSeconds(output: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
  if (!match) return null;
  const duration = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

async function readDurationSeconds(filePath: string): Promise<number> {
  const result = await runFfmpeg(['-hide_banner', '-i', filePath]);
  const duration = parseDurationSeconds(result.stderr);
  if (duration === null || (result.exitCode !== 0 && !result.stderr.includes('Duration:'))) {
    throw new Error(INVALID_AUDIO_MESSAGE);
  }
  return duration;
}

/** Trims a retained source into a normalized, bounded WAV clip without modifying the source. */
export async function trimSourceFile(input: TrimSourceFileInput): Promise<{
  buffer: Buffer;
  durationSec: number;
  sourceDurationSec: number;
}> {
  const uploadMeta = validateUploadMeta('source', input.mimeType, input.source.length);
  if (!uploadMeta.ok) throw new Error(uploadMeta.message);
  if (!detectSupportedAudioMimeType(input.source)) throw new Error(UNSUPPORTED_AUDIO_MESSAGE);

  const directory = await mkdtemp(join(tmpdir(), 'soundboard-trim-'));
  const sourcePath = join(directory, 'source');
  const playablePath = join(directory, 'playable.wav');

  try {
    await writeFile(sourcePath, input.source);
    const sourceDurationSec = await readDurationSeconds(sourcePath);
    const range = validateTrimRange({
      trimStartMs: input.trimStartMs,
      trimEndMs: input.trimEndMs,
      sourceDurationMs: sourceDurationSec * 1_000,
    });
    if (!range.ok) throw new Error(range.message);
    if (estimateNormalizedWavBytes(range.value.trimEndMs - range.value.trimStartMs) > MAX_SOUND_BYTES) {
      throw new Error(INVALID_AUDIO_MESSAGE);
    }

    const result = await runFfmpeg([
      '-hide_banner',
      '-y',
      '-ss', String(range.value.trimStartMs / 1_000),
      '-to', String(range.value.trimEndMs / 1_000),
      '-i', sourcePath,
      '-vn',
      '-ac', '2',
      '-ar', String(NORMALIZED_WAV_SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      playablePath,
    ]);
    if (result.exitCode !== 0) throw new Error(INVALID_AUDIO_MESSAGE);

    let outputStats;
    try {
      outputStats = await stat(playablePath);
    } catch {
      throw new Error(INVALID_AUDIO_MESSAGE);
    }
    if (outputStats.size <= 44 || outputStats.size > MAX_SOUND_BYTES) {
      throw new Error(INVALID_AUDIO_MESSAGE);
    }
    const durationSec = await readDurationSeconds(playablePath);
    return { buffer: await readFile(playablePath), durationSec, sourceDurationSec };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
