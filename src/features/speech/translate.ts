/**
 * translate.ts — Lightweight text translation.
 *
 * Uses Google Translate's free (unofficial, keyless) `translate_a/single`
 * endpoint. No API key required. This is fine for personal/low-volume use;
 * if it ever rate-limits or breaks, swap this single function out for an
 * LLM-based translator (e.g. Gemini, whose key is already configured).
 */

/**
 * Translate `text` into the target language (default Japanese).
 *
 * @param text  Source text in any language (auto-detected)
 * @param to    Target language code (e.g. 'ja', 'en', 'th')
 * @returns     The translated text
 * @throws      If the request fails or returns an unexpected shape
 */
export async function translate(text: string, to = 'ja'): Promise<string> {
  text = text.trim();
  if (!text) throw new Error('Type a message to translate.');
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      // A browser-like UA reduces the chance of being blocked.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`translate request failed: HTTP ${res.status}`);
  }

  const data: unknown = await res.json();
  const segments = Array.isArray(data) ? data[0] : undefined;
  if (!Array.isArray(segments)) {
    throw new Error('translate returned an unexpected response shape');
  }

  if (segments.some((seg: unknown) => !Array.isArray(seg) || typeof seg[0] !== 'string')) {
    throw new Error('translate returned an unexpected response shape');
  }
  const out = segments.map((seg: [string]) => seg[0]).join('').trim();
  if (!out) {
    throw new Error('translate returned empty text');
  }
  return out;
}

/** Convenience wrapper: translate to Japanese for VOICEVOX. */
export async function translateToJapanese(text: string): Promise<string> {
  try {
    return await translate(text, 'ja');
  } catch (error) {
    throw new Error('Could not translate to Japanese. Please try again, or enter Japanese and select “Read as typed”.', { cause: error });
  }
}
