/**
 * gemini.ts — Google Gemini TTS provider.
 *
 * TTS uses the REST `generateContent` endpoint directly. The SDK in
 * version 0.24.x doesn't expose typed `responseModalities` for audio,
 * and rather than fight the type surface we issue the documented REST
 * call. The returned audio is base64-encoded raw PCM (24 kHz / mono /
 * 16-bit), which we wrap in a WAV header before handing back to
 * `session.ts` — FFmpeg (StreamType.Arbitrary) plays WAV fine.
 *
 * (The brain and STT factories were removed when the AI voice-chat pipeline
 * was replaced by the TTS-only `/say` command.)
 */

import type { TtsProvider } from './types';
import { pcmToWav } from '../audio';

// Gemini TTS returns 24 kHz / 1 ch / 16-bit PCM. These constants document that
// contract; if Google changes the format we'll need to revisit.
const GEMINI_TTS_RATE_HZ = 24000;
const GEMINI_TTS_CHANNELS = 1;
const GEMINI_TTS_BITS = 16;

/* ────────────────────────────  TTS  ──────────────────────────── */

interface GeminiTtsPart {
  inlineData?: { mimeType?: string; data?: string };
}
interface GeminiTtsResponse {
  candidates?: Array<{ content?: { parts?: GeminiTtsPart[] } }>;
  error?: { message?: string };
}

/** Pull a short, human-readable reason out of a Gemini error body. */
function geminiErrorReason(status: number, rawBody: string): string {
  let detail = rawBody;
  try {
    detail = (JSON.parse(rawBody) as GeminiTtsResponse).error?.message ?? rawBody;
  } catch {
    // not JSON — use the raw text
  }
  const hint =
    status === 429
      ? ' (Gemini free-tier TTS allows only ~10 requests/day — try VOICEVOX, or wait/upgrade.)'
      : '';
  return `Gemini TTS error ${status}: ${detail.slice(0, 200)}${hint}`;
}

export function createGeminiTTS(apiKey: string, model: string, voice: string): TtsProvider {
  return {
    name: 'gemini',
    async synthesize(text: string, voiceOverride?: string): Promise<Buffer> {
      const voiceName = voiceOverride ?? voice;
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        `:generateContent?key=${encodeURIComponent(apiKey)}`;

      const body = {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      };

      // Throw on failure (instead of returning empty) so callers can surface
      // the real reason — e.g. a 429 quota error — to the user.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const reason = geminiErrorReason(res.status, await res.text());
        console.error(`[tts:gemini] ${reason}`);
        throw new Error(reason);
      }

      const json = (await res.json()) as GeminiTtsResponse;
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const audioPart = parts.find((p) => p.inlineData?.data);
      const dataB64 = audioPart?.inlineData?.data;
      if (!dataB64) {
        console.error('[tts:gemini] response missing inlineData audio:', JSON.stringify(json).slice(0, 400));
        throw new Error('Gemini TTS returned no audio data.');
      }

      // Gemini returns raw PCM. Wrap it in a WAV container so FFmpeg/Discord
      // can play it via StreamType.Arbitrary.
      const pcm = Buffer.from(dataB64, 'base64');
      return pcmToWav(pcm, GEMINI_TTS_RATE_HZ, GEMINI_TTS_CHANNELS, GEMINI_TTS_BITS);
    },
  };
}
