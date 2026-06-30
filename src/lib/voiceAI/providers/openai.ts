/**
 * openai.ts — OpenAI TTS provider.
 *
 * (The brain and STT factories were removed when the AI voice-chat pipeline
 * was replaced by the TTS-only `/say` command.)
 */

import type { TtsProvider } from './types';

interface TtsOptions {
  apiKey: string;
  model: string;
  voice: string;
}

export function createOpenAITTS(opts: TtsOptions): TtsProvider {
  return {
    name: 'openai',
    async synthesize(text: string, voice?: string): Promise<Buffer> {
      try {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            voice: voice ?? opts.voice,
            input: text,
            response_format: 'mp3',
          }),
        });

        if (!res.ok) {
          console.error(`[tts:openai] API error ${res.status}: ${await res.text()}`);
          return Buffer.alloc(0);
        }

        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        console.error('[tts:openai] synthesize error:', err);
        return Buffer.alloc(0);
      }
    },
  };
}
