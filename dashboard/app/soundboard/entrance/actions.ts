'use server';
import { getSoundboardSessionUser } from '@/lib/session';
import { getSelectedGuildId, lockedGuildId } from '@/lib/guild';
import { listAuthorizedGuilds, listGuilds } from '@/lib/discord';
import { getEntrancePreference, saveEntrancePreference } from '@/lib/entrance';
import { getSound, listSounds } from '@/lib/sounds';
import { getSoundPlayableUrl } from '../actions';
import { cleanupEntranceSpeech, GOOGLE_VOICES, previewSavedSpeech, queueSpeechCleanup, synthesizeEntranceSpeech, uploadEntranceSpeech, validateSpeechInput } from '@/lib/entrance-speech';
import { listVoicevoxSpeakers } from '@/lib/voicevox';
import type { SpeechProvider } from '@/lib/entrance';

export type EntranceSaveInput = { enabled: boolean; mode?: 'sound'; soundId: string | null }
  | { enabled: boolean; mode: 'speech'; speechText: string; speechProvider: SpeechProvider; speechVoice: string };

async function identity() {
  const user = await getSoundboardSessionUser();
  if (!user) throw new Error('Not authenticated.');
  const guildId = await getSelectedGuildId();
  if (!guildId || !(await listAuthorizedGuilds(user.id)).some((guild) => guild.id === guildId)) throw new Error('No authorized server selected.');
  return { guildId, userId: user.id };
}

export async function loadEntranceData() {
  const user = await getSoundboardSessionUser();
  if (!user) throw new Error('Not authenticated.');
  const [botGuilds, selectedGuildId, locked] = await Promise.all([
    listGuilds(), getSelectedGuildId(), lockedGuildId(),
  ]);
  const guilds = locked ? botGuilds.filter((guild) => guild.id === locked) : botGuilds;
  const selected = guilds.find((guild) => guild.id === selectedGuildId) ?? null;
  if (!selected) return { guilds, selectedGuildId: null, preference: null, sounds: [], guildName: null, settingsError: null, voicevoxVoices: [] as { id: string; name: string }[], googleVoices: GOOGLE_VOICES };
  try {
    if (!(await listAuthorizedGuilds(user.id)).some((guild) => guild.id === selected.id)) {
      return { guilds, selectedGuildId: selected.id, preference: null, sounds: [], guildName: selected.name, settingsError: 'You do not have access to this server.', voicevoxVoices: [], googleVoices: GOOGLE_VOICES };
    }
    const [preference, sounds, voicevoxVoices] = await Promise.all([
      getEntrancePreference(selected.id, user.id), listSounds(), listVoicevoxSpeakers().catch(() => []),
    ]);
    await cleanupEntranceSpeech().catch((error) => console.error('[entrance] speech cleanup failed:', error));
    return {
      guilds, selectedGuildId: selected.id, preference,
      sounds: sounds.map(({ id, name, durationSec }) => ({ id, name, durationSec })),
      guildName: selected.name, settingsError: null, voicevoxVoices, googleVoices: GOOGLE_VOICES,
    };
  } catch (error) {
    const missingTable = error instanceof Error
      && error.message.includes('VoiceEntrancePreference')
      && error.message.includes('schema cache');
    if (!missingTable) console.error('[entrance] failed to load selected server settings:', error);
    return {
      guilds, selectedGuildId: selected.id, preference: null, sounds: [], guildName: selected.name,
      voicevoxVoices: [], googleVoices: GOOGLE_VOICES, settingsError: missingTable
        ? 'Entrance settings are not installed in the database yet. Ask the server owner to apply the entrance preference migration.'
        : 'Could not load entrance settings for this server.',
    };
  }
}

export async function saveEntrance(input: EntranceSaveInput): Promise<{ ok: boolean; message: string }> {
  try {
    const { guildId, userId } = await identity();
    if (!input || typeof input.enabled !== 'boolean') throw new Error('Invalid preference.');
    if (input.mode === 'speech') {
      if (typeof input.speechText !== 'string' || typeof input.speechVoice !== 'string') throw new Error('Invalid speech settings.');
      const speechText = await validateSpeechInput(input.speechText, input.speechProvider, input.speechVoice);
      const current = await getEntrancePreference(guildId, userId);
      let speechPath = current.mode === 'speech' && current.speechText === speechText
        && current.speechProvider === input.speechProvider && current.speechVoice === input.speechVoice
        ? current.speechPath : null;
      let speechDurationSec = speechPath ? current.speechDurationSec : null;
      let freshPath: string | null = null;
      if (!speechPath || speechDurationSec == null) {
        const generated = await synthesizeEntranceSpeech(speechText, input.speechProvider, input.speechVoice);
        freshPath = await uploadEntranceSpeech(guildId, userId, generated.buffer);
        speechPath = freshPath;
        speechDurationSec = generated.durationSec;
      }
      try {
        await saveEntrancePreference(guildId, userId, { enabled: input.enabled, mode: 'speech', soundId: null,
          speechText, speechProvider: input.speechProvider, speechVoice: input.speechVoice, speechPath, speechDurationSec });
      } catch (error) {
        if (freshPath) await queueSpeechCleanup(freshPath).catch(async (cleanupError) => {
          console.error('[entrance] failed to queue speech cleanup:', cleanupError);
          const { createAdminClient } = await import('@/lib/supabase/admin');
          await createAdminClient().storage.from('sounds').remove([freshPath!]).catch(() => {});
        });
        throw error;
      }
      await cleanupEntranceSpeech().catch((error) => console.error('[entrance] speech cleanup failed:', error));
      return { ok: true, message: 'Entrance speech saved.' };
    }
    if (input.mode !== undefined && input.mode !== 'sound') throw new Error('Invalid preference mode.');
    if (input.soundId !== null && (typeof input.soundId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.soundId))) throw new Error('Invalid preference.');
    if (input.soundId) {
      const sound = await getSound(input.soundId);
      if (!sound || sound.durationSec == null || !Number.isFinite(sound.durationSec) || sound.durationSec < 0.1 || sound.durationSec > 5) {
        if (input.enabled) throw new Error('Choose a sound between 0.1 and 5 seconds.');
      }
    } else if (input.enabled) throw new Error('Choose a sound before enabling.');
    await saveEntrancePreference(guildId, userId, { enabled: input.enabled, soundId: input.soundId, mode: 'sound' });
    await cleanupEntranceSpeech().catch((error) => console.error('[entrance] speech cleanup failed:', error));
    return { ok: true, message: 'Entrance sound saved.' };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export async function previewEntranceSpeech() {
  try {
    const { guildId, userId } = await identity();
    return { ok: true, value: await previewSavedSpeech(guildId, userId) };
  } catch (error) { return { ok: false, message: (error as Error).message }; }
}

export async function previewEntrance(soundId: string) {
  try { await identity(); } catch { return { ok: false as const, message: 'Not authorized.' }; }
  return getSoundPlayableUrl(soundId);
}
