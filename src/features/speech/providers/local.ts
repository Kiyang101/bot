import type { TtsProvider } from './types';

export function createLocalTTS(
  root = process.env.LOCAL_TTS_URL?.trim() || 'http://127.0.0.1:8788',
  voice = process.env.LOCAL_TTS_VOICE?.trim() || 'f_young_clear',
): TtsProvider {
  return {
    name: 'local',
    async synthesize(text, overrideVoice) {
      const response = await fetch(`${root.replace(/\/$/, '')}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: overrideVoice || voice }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Local TTS HTTP ${response.status}`);
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF'
        || audio.toString('ascii', 8, 12) !== 'WAVE'
        || audio.toString('ascii', 12, 16) !== 'fmt '
        || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1
        || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 24000
        || audio.readUInt16LE(34) !== 16 || audio.toString('ascii', 36, 40) !== 'data'
        || audio.readUInt32LE(40) === 0 || audio.readUInt32LE(40) > audio.length - 44) {
        throw new Error('Local TTS returned empty or invalid WAV audio');
      }
      return audio;
    },
  };
}
