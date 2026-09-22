/**
 * providers/index.ts — Public entry to the provider layer.
 *
 * Exposes the `getTtsProvider` lazy factory plus the `missingKeys()` helper.
 * (The brain/STT factories were removed when the AI voice-chat pipeline was
 * replaced by the TTS-only `/say` command.)
 *
 * Behavior contract:
 *   - Provider selection is read once and cached per stage. Restart the
 *     process to pick up `.env` changes.
 *   - If the stage's API key is missing, the factory returns `null` and the
 *     wrapper module degrades gracefully (empty buffer).
 *   - If TTS is configured with an audio-incapable provider
 *     (anthropic/openrouter), the env reader in `config.ts` throws at first
 *     access — that's the "fail at startup" behavior the spec asks for.
 */

import type { TtsProvider } from './types';
import {
  getSelectedProviders,
  resolveApiKey,
  resolveModel,
  resolveTtsVoice,
  resolveVoicevoxUrl,
  resolveGoogleLang,
  expectedKeyEnvNames,
  DEFAULTS,
} from './config';
import { createOpenAITTS } from './openai';
import { createGeminiTTS } from './gemini';
import { createVoicevoxTTS } from './voicevox';
import { createGoogleTTS } from './googletts';

// Module-level cache. We deliberately cache the *attempt* (including null)
// so we only print "missing key" warnings once per process per stage.
let ttsCache: { built: TtsProvider | null } | null = null;

function buildTts(): TtsProvider | null {
  const { tts } = getSelectedProviders();

  // VOICEVOX is a local engine — no API key, just a base URL.
  if (tts === 'voicevox') {
    return createVoicevoxTTS(resolveVoicevoxUrl(), resolveTtsVoice('voicevox'));
  }

  // Google TTS is free and keyless — just a default language code.
  if (tts === 'googletts') {
    return createGoogleTTS(resolveGoogleLang());
  }

  const apiKey = resolveApiKey('TTS', tts);
  if (!apiKey) {
    const candidates = expectedKeyEnvNames('TTS', tts).join(' or ');
    console.warn(
      `[voiceAI] TTS provider "${tts}" selected but no API key found. Set ${candidates}.`,
    );
    return null;
  }
  const model = resolveModel('TTS', DEFAULTS.tts[tts]);
  const voice = resolveTtsVoice(tts);
  switch (tts) {
    case 'openai':
      return createOpenAITTS({ apiKey, model, voice });
    case 'gemini':
      return createGeminiTTS(apiKey, model, voice);
  }
}

/** Get (and cache) the TTS provider, or null if the key is missing. */
export function getTtsProvider(): TtsProvider | null {
  if (!ttsCache) ttsCache = { built: buildTts() };
  return ttsCache.built;
}

/**
 * Return the list of env-var names that need to be set so all three stages
 * have a valid API key. One representative name per missing stage — we
 * prefer the provider-default name (e.g. `GEMINI_API_KEY`) over the stage
 * override (`AI_BRAIN_API_KEY`) since most users will use the former.
 *
 * Returns [] when everything is reachable.
 *
 * Does NOT throw — if the user has misconfigured a provider name
 * (e.g. AI_STT_PROVIDER=anthropic), surface that as a special string so
 * the command can show a clear error instead of crashing.
 */
export function missingKeys(): string[] {
  const missing: string[] = [];

  let selected: ReturnType<typeof getSelectedProviders>;
  try {
    selected = getSelectedProviders();
  } catch (err) {
    // Misconfiguration — return the message so `/voice-ai` can show it.
    const message = err instanceof Error ? err.message : String(err);
    return [`CONFIG ERROR: ${message}`];
  }

  for (const [stage, provider] of [
    ['BRAIN', selected.brain] as const,
    ['STT', selected.stt] as const,
    ['TTS', selected.tts] as const,
  ]) {
    if (!resolveApiKey(stage, provider)) {
      // Prefer the provider-default key name in the user-facing list.
      const [, providerDefault] = expectedKeyEnvNames(stage, provider);
      missing.push(providerDefault);
    }
  }

  // Dedupe — if the user picked one provider for all three stages they only
  // need to set one key.
  return Array.from(new Set(missing));
}
