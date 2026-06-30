/**
 * voicevox.ts — VOICEVOX TTS provider (local, keyless).
 *
 * VOICEVOX is a free Japanese text-to-speech engine with anime-style
 * character voices (ずんだもん, 四国めたん, …). It runs as a local HTTP
 * server (default http://localhost:50021) — no API key required.
 *
 * Synthesis is a two-step call:
 *   1. POST /audio_query?text=…&speaker=ID  → returns a query JSON
 *   2. POST /synthesis?speaker=ID  (query JSON body) → returns a WAV buffer
 *
 * The returned WAV (24 kHz / mono / 16-bit) plays directly through
 * FFmpeg (StreamType.Arbitrary) in session.ts.
 *
 * NOTE: VOICEVOX only speaks Japanese. Non-Japanese input should be
 * translated first (see lib/voiceAI/translate.ts).
 */

import type { TtsProvider } from './types';

/** A selectable VOICEVOX voice: one character style with its engine id. */
export interface VoicevoxVoiceChoice {
  /** Display label, e.g. "ずんだもん (ノーマル) #3". */
  name: string;
  /** Engine speaker/style id, as a string (slash-command values are strings). */
  id: string;
}

interface VoicevoxSpeaker {
  name: string;
  styles: Array<{ name: string; id: number; type?: string }>;
}

// Cache the speaker list briefly so autocomplete keystrokes don't hammer the engine.
let speakerCache: { at: number; list: VoicevoxVoiceChoice[] } | null = null;
const SPEAKER_CACHE_MS = 5 * 60_000;

/**
 * Fetch the speakers installed in the running VOICEVOX engine and flatten them
 * into one choice per character-style. Cached for a few minutes. Throws if the
 * engine is unreachable.
 */
export async function fetchVoicevoxSpeakers(baseUrl: string): Promise<VoicevoxVoiceChoice[]> {
  if (speakerCache && Date.now() - speakerCache.at < SPEAKER_CACHE_MS) {
    return speakerCache.list;
  }

  const root = baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${root}/speakers`);
  if (!res.ok) {
    throw new Error(`/speakers HTTP ${res.status}`);
  }

  const data = (await res.json()) as VoicevoxSpeaker[];
  const list: VoicevoxVoiceChoice[] = [];
  for (const sp of data) {
    for (const st of sp.styles) {
      if (st.type && st.type !== 'talk') continue; // skip non-speech styles (song, humming…)
      list.push({ name: `${sp.name} (${st.name}) #${st.id}`, id: String(st.id) });
    }
  }

  speakerCache = { at: Date.now(), list };
  return list;
}

/** Pick a valid speaker id: the per-call override, else the default, else 3. */
function pickSpeaker(voice: string | undefined, fallback: string): string {
  if (voice && /^\d+$/.test(voice)) return voice;
  if (/^\d+$/.test(fallback)) return fallback;
  return '3'; // ずんだもん Normal
}

/** Optional voice tuning applied to the VOICEVOX audio query. */
export interface VoicevoxTuning {
  /** Playback speed multiplier (VOICEVOX speedScale, ~0.5–2.0; default 1.0). */
  speed?: number;
  /** Pitch shift (VOICEVOX pitchScale, ~-0.15–0.15; default 0). */
  pitch?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function createVoicevoxTTS(
  baseUrl: string,
  defaultSpeaker: string,
  tuning: VoicevoxTuning = {},
): TtsProvider {
  const root = baseUrl.replace(/\/+$/, '');

  return {
    name: 'voicevox',
    async synthesize(text: string, voice?: string): Promise<Buffer> {
      const speaker = pickSpeaker(voice, defaultSpeaker);
      try {
        // Step 1: build the audio query for this text + speaker.
        const queryRes = await fetch(
          `${root}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
          { method: 'POST' },
        );
        if (!queryRes.ok) {
          console.error(`[tts:voicevox] audio_query error ${queryRes.status}: ${await queryRes.text()}`);
          return Buffer.alloc(0);
        }
        const query = (await queryRes.json()) as {
          accent_phrases?: unknown[];
          speedScale?: number;
          pitchScale?: number;
        };

        // If the engine found nothing pronounceable (e.g. text it can't read),
        // accent_phrases is empty — there's no audio to make. Return empty so
        // the caller can warn instead of playing a silent clip.
        if (!query.accent_phrases || query.accent_phrases.length === 0) {
          console.log(`[tts:voicevox] no pronounceable content for "${text}" — skipping`);
          return Buffer.alloc(0);
        }

        // Apply speed/pitch tuning to the query before synthesizing.
        if (tuning.speed !== undefined) query.speedScale = clamp(tuning.speed, 0.5, 2.0);
        if (tuning.pitch !== undefined) query.pitchScale = clamp(tuning.pitch, -0.15, 0.15);

        // Step 2: synthesize WAV audio from the query.
        const synthRes = await fetch(`${root}/synthesis?speaker=${speaker}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query),
        });
        if (!synthRes.ok) {
          console.error(`[tts:voicevox] synthesis error ${synthRes.status}: ${await synthRes.text()}`);
          return Buffer.alloc(0);
        }

        return Buffer.from(await synthRes.arrayBuffer());
      } catch (err) {
        console.error(
          `[tts:voicevox] synthesize error — is the VOICEVOX engine running at ${root}?`,
          err,
        );
        return Buffer.alloc(0);
      }
    },
  };
}
