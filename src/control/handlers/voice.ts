import type { Client } from 'discord.js';
import { voiceSession } from '../../features/speech/session';
import { createVoicevoxTTS } from '../../features/speech/providers/voicevox';
import { createGoogleTTS } from '../../features/speech/providers/googletts';
import { resolveVoicevoxUrl, resolveTtsVoice, resolveGoogleLang, getSelectedProviders } from '../../features/speech/providers/config';
import { translateToJapanese } from '../../features/speech/translate';
import { synthesize as synthesizeDefault } from '../../features/speech/tts';
import type { TtsProvider } from '../../features/speech/providers/types';
import { resolveDashboardVoiceChannel } from '../channels';

export interface SpeakBody {
  guildId?: string;
  channelId?: string;
  userId?: string;
  text?: string;
  voice?: string;
  provider?: 'default' | 'voicevox' | 'google';
  translate?: boolean;
  speed?: number;
  pitch?: number;
}

/**
 * Pick the TTS provider for a request. VOICEVOX (anime/Japanese) and Google TTS
 * (Thai & more) are forced when requested; otherwise `undefined` is returned so
 * the caller falls back to the bot's configured provider (AI_TTS_PROVIDER).
 * Speed/pitch tuning only applies to VOICEVOX; for Google TTS the `voice` field
 * is a language code.
 */
function usesVoicevox(body: SpeakBody): boolean {
  return body.provider === 'voicevox' || ((!body.provider || body.provider === 'default') && getSelectedProviders().tts === 'voicevox');
}

async function prepareText(body: SpeakBody): Promise<string> {
  const text = (body.text ?? '').trim();
  if (!text) throw new Error('text is required');
  if (text.length > 500) throw new Error('Message must be 500 characters or fewer.');
  return usesVoicevox(body) && body.translate !== false ? translateToJapanese(text) : text;
}

function buildTts(body: SpeakBody): TtsProvider | undefined {
  if (usesVoicevox(body)) {
    return createVoicevoxTTS(resolveVoicevoxUrl(), resolveTtsVoice('voicevox'), {
      speed: typeof body.speed === 'number' ? body.speed : undefined,
      pitch: typeof body.pitch === 'number' ? body.pitch : undefined,
    });
  }
  if (body.provider === 'google') {
    return createGoogleTTS(resolveGoogleLang());
  }
  return undefined;
}

export async function handleSpeak(client: Client, body: SpeakBody): Promise<{ spoken: string }> {
  const text = (body.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const guildId = (body.guildId ?? '').trim();
  if (!guildId) throw new Error('guildId is required');
  const channel = await resolveDashboardVoiceChannel(client, guildId, body.channelId, body.userId);

  // Optionally translate to Japanese (for VOICEVOX anime voices).
  const spoken = await prepareText(body);
  const tts = buildTts(body);

  await voiceSession.speak(channel, spoken, body.voice || undefined, tts);
  return { spoken };
}

/**
 * Synthesize a clip for the dashboard's "Test" button WITHOUT joining a voice
 * channel — the audio bytes are returned so the user can hear them in their
 * browser before sending the bot to a channel. Uses the same provider/voice/
 * translate logic as {@link handleSpeak}.
 */
export async function handlePreview(body: SpeakBody): Promise<{ audio: Buffer; spoken: string }> {
  const text = (body.text ?? '').trim();
  if (!text) throw new Error('text is required');

  const spoken = await prepareText(body);
  const tts = buildTts(body);
  const audio = tts
    ? await tts.synthesize(spoken, body.voice || undefined)
    : await synthesizeDefault(spoken, body.voice || undefined);

  if (!audio || audio.length === 0) {
    throw new Error(
      'No audio was produced — check the selected TTS engine/provider is running and configured.',
    );
  }
  return { audio, spoken };
}

export function handleLeave(body: { guildId?: string }): void {
  const guildId = (body.guildId ?? '').trim();
  if (!guildId) throw new Error('guildId is required');
  voiceSession.leave(guildId);
}
