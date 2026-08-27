import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { MAX_SOUND_BYTES, validateTrimRange } from './sound-validation';

const AUDIO_PROCESSING_UNAVAILABLE = 'Audio processing is unavailable on this dashboard host.';
const INVALID_AUDIO_MESSAGE = 'The uploaded audio file could not be processed.';

type TrimSourceFileInput = {
  source: Buffer | Uint8Array;
  mimeType: string;
  trimStartMs: number;
  trimEndMs: number;
};

type ProcessResult = { exitCode: number | null; stderr: string };

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
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        reject(new Error(AUDIO_PROCESSING_UNAVAILABLE));
        return;
      }
      reject(error);
    });
    child.once('close', (exitCode) => resolve({ exitCode, stderr }));
  });
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
  if (!input.source.length || input.source.length > MAX_SOUND_BYTES) {
    throw new Error(INVALID_AUDIO_MESSAGE);
  }

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

    const result = await runFfmpeg([
      '-hide_banner',
      '-y',
      '-ss', String(range.value.trimStartMs / 1_000),
      '-to', String(range.value.trimEndMs / 1_000),
      '-i', sourcePath,
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-c:a', 'pcm_s16le',
      playablePath,
    ]);
    if (result.exitCode !== 0) throw new Error(INVALID_AUDIO_MESSAGE);

    const outputStats = await stat(playablePath);
    if (outputStats.size <= 44 || outputStats.size > MAX_SOUND_BYTES) {
      throw new Error(INVALID_AUDIO_MESSAGE);
    }
    const durationSec = await readDurationSeconds(playablePath);
    return { buffer: await readFile(playablePath), durationSec };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
