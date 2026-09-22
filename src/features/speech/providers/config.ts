/**
 * config.ts — Env-driven configuration for the Voice AI provider layer.
 *
 * Pure functions: each one reads `process.env` and returns the resolved
 * value or `null`. Validation (which keys are required, what's a fatal
 * misconfiguration) lives in `index.ts`, so this module stays trivially
 * testable.
 */

export type BrainProviderName = 'anthropic' | 'openai' | 'gemini' | 'openrouter';
export type SttProviderName = 'openai' | 'gemini';
// 'voicevox' is a local, keyless TTS engine (anime-style Japanese voices).
// 'googletts' is Google Translate's free, keyless TTS (Thai + many languages).
export type TtsProviderName = 'openai' | 'gemini' | 'voicevox' | 'googletts';

/** All providers that exist in the system, including ones that can't do audio. */
export type AnyProviderName = BrainProviderName | SttProviderName | TtsProviderName;

/** Default model IDs per provider per stage. */
export const DEFAULTS = {
  brain: {
    anthropic: 'claude-opus-4-8',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-2.0-flash',
    openrouter: 'anthropic/claude-opus-4',
  },
  stt: {
    openai: 'whisper-1',
    gemini: 'gemini-2.0-flash',
  },
  tts: {
    openai: 'tts-1',
    gemini: 'gemini-2.5-flash-preview-tts',
    voicevox: '', // VOICEVOX selects voice by speaker id, not a model name
    googletts: '', // Google TTS selects by language code, not a model name
  },
  ttsVoice: {
    openai: 'alloy',
    gemini: 'Kore',
    voicevox: '3', // ずんだもん (Zundamon) Normal — default anime girl voice
    googletts: 'th', // default language: Thai
  },
} as const;

/**
 * Selectable voice names for the API providers (name === value). Discord caps
 * slash-command choices at 25, so keep each list at or under that limit.
 */
const API_TTS_VOICES: Record<'openai' | 'gemini', string[]> = {
  openai: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'],
  gemini: [
    'Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir', 'Aoede', 'Leda', 'Orus',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Sulafat',
  ],
};

/**
 * VOICEVOX speakers: human-readable label → engine speaker id (as a string).
 * These are stable ids from the stock VOICEVOX voice library; female /
 * anime-girl styles are listed first. Run `GET {VOICEVOX_URL}/speakers` to
 * see everything your local engine actually has installed.
 */
const VOICEVOX_SPEAKERS: { name: string; id: string }[] = [
  { name: 'Zundamon ずんだもん (Normal)', id: '3' },
  { name: 'Zundamon ずんだもん (Sweet/あまあま)', id: '1' },
  { name: 'Zundamon ずんだもん (Whisper/ささやき)', id: '22' },
  { name: 'Shikoku Metan 四国めたん (Normal)', id: '2' },
  { name: 'Shikoku Metan 四国めたん (Sweet/あまあま)', id: '0' },
  { name: 'Shikoku Metan 四国めたん (Tsun/ツンツン)', id: '6' },
  { name: 'Kasukabe Tsumugi 春日部つむぎ', id: '8' },
  { name: 'Amehare Hau 雨晴はう', id: '10' },
  { name: 'Kyushu Sora 九州そら (Normal)', id: '16' },
  { name: 'Meimei Himari 冥鳴ひまり', id: '14' },
  { name: 'Mochikosan もち子さん', id: '20' },
  { name: 'Namine Ritsu 波音リツ', id: '9' },
];

/**
 * Choices for the `/say` voice dropdown for the given provider. Returns
 * `{ name, value }` pairs — for VOICEVOX the value is the speaker id; for the
 * API providers the value is the voice name itself.
 */
export function ttsVoiceChoices(provider: TtsProviderName): { name: string; value: string }[] {
  if (provider === 'voicevox') {
    return VOICEVOX_SPEAKERS.map((s) => ({ name: s.name, value: s.id }));
  }
  if (provider === 'googletts') {
    return GOOGLE_TTS_LANGS.map((l) => ({ name: l.name, value: l.id }));
  }
  return API_TTS_VOICES[provider].map((v) => ({ name: v, value: v }));
}

/** Languages offered for Google TTS, for the dashboard dropdown. */
export function googleTtsLanguages(): { name: string; value: string }[] {
  return GOOGLE_TTS_LANGS.map((l) => ({ name: l.name, value: l.id }));
}

/** Provider-default env-var name for each provider's "house" API key. */
const PROVIDER_KEY_ENV: Record<AnyProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  voicevox: 'VOICEVOX_URL', // VOICEVOX needs no key; this entry only satisfies the type
  googletts: 'GTTS_LANG', // Google TTS needs no key; this entry only satisfies the type
};

/** Languages offered for Google TTS (label → BCP-47-ish code). Thai first. */
const GOOGLE_TTS_LANGS: { name: string; id: string }[] = [
  { name: 'Thai ไทย', id: 'th' },
  { name: 'English', id: 'en' },
  { name: 'Japanese 日本語', id: 'ja' },
  { name: 'Korean 한국어', id: 'ko' },
  { name: 'Chinese 中文', id: 'zh-CN' },
  { name: 'Vietnamese', id: 'vi' },
  { name: 'Indonesian', id: 'id' },
  { name: 'French', id: 'fr' },
  { name: 'German', id: 'de' },
  { name: 'Spanish', id: 'es' },
  { name: 'Russian', id: 'ru' },
  { name: 'Hindi', id: 'hi' },
];

function readEnv(name: string): string | null {
  const v = process.env[name];
  if (!v || v.trim() === '') return null;
  return v.trim();
}

function asBrainProvider(v: string | null): BrainProviderName {
  switch ((v ?? 'anthropic').toLowerCase()) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'gemini':
      return 'gemini';
    case 'openrouter':
      return 'openrouter';
    default:
      throw new Error(
        `[voiceAI] Unknown AI_BRAIN_PROVIDER="${v}". Allowed: anthropic, openai, gemini, openrouter.`,
      );
  }
}

function asSttProvider(v: string | null): SttProviderName {
  const lower = (v ?? 'openai').toLowerCase();
  if (lower === 'openai' || lower === 'gemini') return lower;
  // Reject providers that don't support audio loudly per spec.
  if (lower === 'anthropic' || lower === 'openrouter') {
    throw new Error(
      `[voiceAI] AI_STT_PROVIDER="${v}" does not support audio. Use openai or gemini.`,
    );
  }
  throw new Error(`[voiceAI] Unknown AI_STT_PROVIDER="${v}". Allowed: openai, gemini.`);
}

function asTtsProvider(v: string | null): TtsProviderName {
  const lower = (v ?? 'openai').toLowerCase();
  if (lower === 'openai' || lower === 'gemini' || lower === 'voicevox') return lower;
  if (lower === 'googletts') return 'googletts';
  if (lower === 'anthropic' || lower === 'openrouter') {
    throw new Error(
      `[voiceAI] AI_TTS_PROVIDER="${v}" does not support audio. Use openai, gemini, voicevox, or googletts.`,
    );
  }
  throw new Error(
    `[voiceAI] Unknown AI_TTS_PROVIDER="${v}". Allowed: openai, gemini, voicevox, googletts.`,
  );
}

/** Base URL of the local VOICEVOX engine. */
export function resolveVoicevoxUrl(): string {
  return readEnv('VOICEVOX_URL') ?? 'http://localhost:50021';
}

/** Default language code for Google TTS. */
export function resolveGoogleLang(): string {
  return readEnv('GTTS_LANG') ?? 'th';
}

/** Selected provider per stage. Throws on bad/unsupported values. */
export function getSelectedProviders(): {
  brain: BrainProviderName;
  stt: SttProviderName;
  tts: TtsProviderName;
} {
  return {
    brain: asBrainProvider(readEnv('AI_BRAIN_PROVIDER')),
    stt: asSttProvider(readEnv('AI_STT_PROVIDER')),
    tts: asTtsProvider(readEnv('AI_TTS_PROVIDER')),
  };
}

/**
 * Resolve the API key for a stage using the documented fallback chain:
 *   1. Stage override (`AI_BRAIN_API_KEY` / `AI_STT_API_KEY` / `AI_TTS_API_KEY`)
 *   2. Provider-default key (`{PROVIDER}_API_KEY`)
 * Returns null if neither is set.
 */
export function resolveApiKey(
  stage: 'BRAIN' | 'STT' | 'TTS',
  provider: AnyProviderName,
): string | null {
  return readEnv(`AI_${stage}_API_KEY`) ?? readEnv(PROVIDER_KEY_ENV[provider]);
}

/** The env-var name that, when set, would supply the resolved key. Used for warnings. */
export function expectedKeyEnvNames(
  stage: 'BRAIN' | 'STT' | 'TTS',
  provider: AnyProviderName,
): string[] {
  // Stage override is always acceptable; provider-default is the conventional one.
  return [`AI_${stage}_API_KEY`, PROVIDER_KEY_ENV[provider]];
}

/** Read `AI_{STAGE}_MODEL` or fall back to the provider default. */
export function resolveModel(
  stage: 'BRAIN' | 'STT' | 'TTS',
  fallback: string,
): string {
  return readEnv(`AI_${stage}_MODEL`) ?? fallback;
}

/** Read `AI_TTS_VOICE` or fall back to the provider default. */
export function resolveTtsVoice(provider: TtsProviderName): string {
  return readEnv('AI_TTS_VOICE') ?? DEFAULTS.ttsVoice[provider];
}
