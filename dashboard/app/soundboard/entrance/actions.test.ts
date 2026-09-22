import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(), selected: vi.fn(), locked: vi.fn(), guilds: vi.fn(), authorized: vi.fn(),
  preference: vi.fn(), savePreference: vi.fn(), sounds: vi.fn(), synthesize: vi.fn(), upload: vi.fn(), validateSpeech: vi.fn(), previewSaved: vi.fn(), cleanup: vi.fn(), getSound: vi.fn(), voices: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ getSoundboardSessionUser: mocks.user }));
vi.mock('@/lib/guild', () => ({ getSelectedGuildId: mocks.selected, lockedGuildId: mocks.locked }));
vi.mock('@/lib/discord', () => ({ listGuilds: mocks.guilds, listAuthorizedGuilds: mocks.authorized }));
vi.mock('@/lib/entrance', () => ({ getEntrancePreference: mocks.preference, saveEntrancePreference: mocks.savePreference }));
vi.mock('@/lib/sounds', () => ({ listSounds: mocks.sounds, getSound: mocks.getSound }));
vi.mock('@/lib/entrance-speech', () => ({ GOOGLE_VOICES: [{ id: 'en', name: 'English' }], validateSpeechInput: mocks.validateSpeech, synthesizeEntranceSpeech: mocks.synthesize, uploadEntranceSpeech: mocks.upload, previewSavedSpeech: mocks.previewSaved, queueSpeechCleanup: vi.fn(), cleanupEntranceSpeech: mocks.cleanup }));
vi.mock('@/lib/voicevox', () => ({ listVoicevoxSpeakers: mocks.voices }));
vi.mock('../actions', () => ({ getSoundPlayableUrl: vi.fn() }));

describe('entrance page data', () => {
  beforeEach(() => {
    mocks.user.mockResolvedValue({ id: 'discord-user', role: 'member' });
    mocks.selected.mockResolvedValue(null);
    mocks.locked.mockResolvedValue(null);
    mocks.guilds.mockResolvedValue([{ id: 'guild-1', name: 'Studio', icon: null }]);
    mocks.authorized.mockResolvedValue([{ id: 'guild-1', name: 'Studio', icon: null }]);
    mocks.preference.mockResolvedValue({ enabled: false, soundId: null });
    mocks.sounds.mockResolvedValue([]);
    mocks.voices.mockResolvedValue([]);
    mocks.cleanup.mockResolvedValue(undefined);
    mocks.validateSpeech.mockImplementation(async (text: string) => text.trim());
    mocks.synthesize.mockResolvedValue({ buffer: Buffer.from('audio'), durationSec: 1 });
    mocks.upload.mockResolvedValue('entrances/1/2/id.wav');
    mocks.savePreference.mockResolvedValue(undefined);
    mocks.preference.mockClear();
    mocks.sounds.mockClear();
  });

  test('synthesizes only when speech settings change and saves a private asset', async () => {
    mocks.selected.mockResolvedValue('guild-1');
    mocks.preference.mockResolvedValue({ enabled: false, mode: 'sound', soundId: null });
    const { saveEntrance } = await import('./actions');
    const input = { enabled: true, mode: 'speech' as const, speechText: 'Hello', speechProvider: 'google' as const, speechVoice: 'en' };
    expect((await saveEntrance(input)).ok).toBe(true);
    expect(mocks.synthesize).toHaveBeenCalledWith('Hello', 'google', 'en');
    expect(mocks.savePreference).toHaveBeenCalledWith('guild-1', 'discord-user', expect.objectContaining({ mode: 'speech', soundId: null, speechPath: 'entrances/1/2/id.wav' }));
    mocks.synthesize.mockClear();
    mocks.preference.mockResolvedValue({ ...input, soundId: null, speechPath: 'entrances/1/2/id.wav', speechDurationSec: 1 });
    expect((await saveEntrance(input)).ok).toBe(true);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  test('offers authorized servers when none is selected', async () => {
    const { loadEntranceData } = await import('./actions');
    const data = await loadEntranceData();
    expect(data.guilds).toEqual([{ id: 'guild-1', name: 'Studio', icon: null }]);
    expect(data.selectedGuildId).toBeNull();
    expect(data.preference).toBeNull();
    expect(mocks.preference).not.toHaveBeenCalled();
    expect(mocks.sounds).not.toHaveBeenCalled();
  });

  test('loads preference only for an authorized selected server', async () => {
    mocks.selected.mockResolvedValue('guild-1');
    const { loadEntranceData } = await import('./actions');
    const data = await loadEntranceData();
    expect(data.selectedGuildId).toBe('guild-1');
    expect(data.guildName).toBe('Studio');
    expect(mocks.preference).toHaveBeenCalledWith('guild-1', 'discord-user');
  });

  test('does not load settings for an unauthorized selected server', async () => {
    mocks.selected.mockResolvedValue('guild-1');
    mocks.authorized.mockResolvedValue([]);
    const { loadEntranceData } = await import('./actions');
    const data = await loadEntranceData();
    expect(data.selectedGuildId).toBe('guild-1');
    expect(mocks.preference).not.toHaveBeenCalled();
    expect(data.settingsError).toMatch(/do not have access/);
  });

  test('keeps the server picker available if preference storage fails', async () => {
    mocks.selected.mockResolvedValue('guild-1');
    mocks.preference.mockRejectedValueOnce(new Error('database unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { loadEntranceData } = await import('./actions');
      const data = await loadEntranceData();
      expect(data.guilds).toEqual([{ id: 'guild-1', name: 'Studio', icon: null }]);
      expect(data.preference).toBeNull();
      expect(data.settingsError).toMatch(/Could not load entrance settings/);
    } finally {
      log.mockRestore();
    }
  });

  test('identifies a missing migration while keeping the server picker', async () => {
    mocks.selected.mockResolvedValue('guild-1');
    mocks.preference.mockRejectedValueOnce(new Error("Could not find the table 'public.VoiceEntrancePreference' in the schema cache"));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { loadEntranceData } = await import('./actions');
      const data = await loadEntranceData();
      expect(data.guilds).toHaveLength(1);
      expect(data.settingsError).toMatch(/migration/);
    } finally {
      log.mockRestore();
    }
  });
});
