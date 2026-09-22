/**
 * googletts.ts — Google Translate TTS provider (free, keyless).
 *
 * Uses Google Translate's `translate_tts` endpoint, the same free service the
 * web translator uses for its "listen" button. No API key required. It speaks
 * many languages — notably **Thai** — with a clear (non-anime) voice.
 *
 * The endpoint caps each request at ~200 characters, so longer text is split
 * into chunks and the resulting MP3 buffers are concatenated (FFmpeg /
 * StreamType.Arbitrary plays the joined stream fine).
 *
 * Here the TtsProvider `voice` argument is a BCP-47-ish language code
 * (e.g. 'th', 'en', 'ja'), not a named voice.
 */

import type { TtsProvider } from './types';

const MAX_CHARS = 200;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Split text into <=200-char pieces, breaking on spaces when possible. */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(' ', MAX_CHARS);
    if (cut <= 0) cut = MAX_CHARS; // no space (e.g. Thai) — hard cut
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function createGoogleTTS(defaultLang: string): TtsProvider {
  return {
    name: 'googletts',
    async synthesize(text: string, voice?: string): Promise<Buffer> {
      const lang = (voice && voice.trim()) || defaultLang || 'th';
      try {
        const parts = chunkText(text);
        const buffers: Buffer[] = [];
        for (let i = 0; i < parts.length; i++) {
          const url =
            'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
            `&tl=${encodeURIComponent(lang)}&total=${parts.length}&idx=${i}` +
            `&textlen=${parts[i].length}&q=${encodeURIComponent(parts[i])}`;
          const res = await fetch(url, { headers: { 'User-Agent': UA } });
          if (!res.ok) {
            console.error(`[tts:google] API error ${res.status}: ${await res.text()}`);
            return Buffer.alloc(0);
          }
          buffers.push(Buffer.from(await res.arrayBuffer()));
        }
        return Buffer.concat(buffers);
      } catch (err) {
        console.error('[tts:google] synthesize error:', err);
        return Buffer.alloc(0);
      }
    },
  };
}
