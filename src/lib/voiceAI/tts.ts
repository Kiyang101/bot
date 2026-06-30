/**
 * tts.ts — Text-to-Speech wrapper.
 *
 * Delegates to whichever provider is selected via `AI_TTS_PROVIDER`
 * (openai by default). Returns an empty Buffer on missing key or
 * synthesis failure so callers in `session.ts` can early-exit.
 */

import { getTtsProvider } from './providers';

/**
 * Synthesize speech from text using the configured TTS provider.
 *
 * @param text   The text to speak aloud
 * @param voice  Optional voice name to override the provider's default for
 *               this call (e.g. picked via the `/say` command's dropdown)
 * @returns      A Buffer containing the audio (mp3 or wav), or an empty Buffer on failure
 */
export async function synthesize(text: string, voice?: string): Promise<Buffer> {
  const provider = getTtsProvider();
  if (!provider) {
    return Buffer.alloc(0);
  }
  return provider.synthesize(text, voice);
}
