/**
 * types.ts — Shared types for the Voice AI provider layer.
 *
 * Each stage of the voice pipeline (brain, STT, TTS) is fronted by a
 * provider interface. Provider implementations are stateless adapters
 * over a vendor SDK / REST API; per-conversation state (e.g. chat
 * history) is kept by the wrapper modules that call into them.
 */

/** A single turn in a brain conversation. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The brain stage — LLM conversational reply. */
export interface BrainProvider {
  /** Provider name (for logs). */
  readonly name: string;
  /**
   * Generate a reply given the conversation so far.
   * Implementations MUST NOT mutate `messages`.
   * Return `''` on transport failure — callers treat empty as "skip reply".
   */
  complete(messages: readonly ChatMessage[], systemPrompt: string): Promise<string>;
}

/** The speech-to-text stage. */
export interface SttProvider {
  readonly name: string;
  /**
   * Transcribe a WAV buffer (48kHz / 2ch / 16-bit produced by `audio.ts`).
   * Return `''` if transcription failed or yielded no text.
   */
  transcribe(wav: Buffer): Promise<string>;
}

/** The text-to-speech stage. */
export interface TtsProvider {
  readonly name: string;
  /**
   * Synthesize speech for `text`. Returns an audio Buffer (mp3 or wav).
   * `session.ts` plays it through FFmpeg (`StreamType.Arbitrary`), which
   * handles either container — so providers may return whatever their
   * native API gives back.
   * `voice` overrides the provider's configured default voice for this one
   * call; when omitted, the default voice is used.
   * Return an empty Buffer on failure — callers check `.length` before playing.
   */
  synthesize(text: string, voice?: string): Promise<Buffer>;
}
