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

function startsWithBytes(source: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => source[index] === byte);
}

function isMp3FrameHeader(source: Uint8Array): boolean {
  if (source.length < 4 || source[0] !== 0xff) return false;
  const version = (source[1] >> 3) & 0b11;
  const layer = (source[1] >> 1) & 0b11;
  const bitrate = (source[2] >> 4) & 0b1111;
  const sampleRate = (source[2] >> 2) & 0b11;
  return (source[1] & 0b1110_0000) === 0b1110_0000
    && version !== 0b01
    && layer !== 0
    && bitrate !== 0
    && bitrate !== 0b1111
    && sampleRate !== 0b11;
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
  if (startsWithBytes(source, [0x49, 0x44, 0x33]) || isMp3FrameHeader(source)) return 'audio/mpeg';
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
export async function trimSourceFile(input: TrimSourceFileInput): Promise<{ buffer: Buffer; durationSec: number }> {
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
    return { buffer: await readFile(playablePath), durationSec };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
