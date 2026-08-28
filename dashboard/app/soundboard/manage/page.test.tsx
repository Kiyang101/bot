import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SoundRecord } from '@/lib/sound-types';

const mocks = vi.hoisted(() => ({
  getSoundboardSessionUser: vi.fn(),
  getSignedSoundUrl: vi.fn(),
  listSounds: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSoundboardSessionUser: mocks.getSoundboardSessionUser }));
vi.mock('@/lib/sounds', () => ({
  getSignedSoundUrl: mocks.getSignedSoundUrl,
  listSounds: mocks.listSounds,
}));

const sound: SoundRecord = {
  id: 'global-sound',
  name: 'Global horn',
  category: 'Reactions',
  color: '#5865f2',
  storagePath: 'sounds/user-1/global-sound/playable',
  sourceStoragePath: 'sounds/user-1/global-sound/source',
  mimeType: 'audio/wav',
  sizeBytes: 1024,
  durationSec: 1,
  uploadedById: 'user-1',
  uploadedByName: 'Kai',
  shortcut: null,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  trimStartMs: 0,
  trimEndMs: 1000,
  sortOrder: 0,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

describe('sound management page loader', () => {
  beforeEach(() => {
    mocks.getSoundboardSessionUser.mockResolvedValue({ id: 'user-1', username: 'Kai', role: 'member' });
    mocks.listSounds.mockResolvedValue([sound]);
    mocks.getSignedSoundUrl.mockImplementation(async (path: string) => `https://signed.example/${path}`);
  });

  test('loads the global list with the shared role policy without eagerly exposing source URLs', async () => {
    const { loadManagementPageData } = await import('./loader');

    const data = await loadManagementPageData();

    expect(mocks.listSounds).toHaveBeenCalledWith();
    expect(mocks.getSignedSoundUrl).toHaveBeenCalledWith(sound.storagePath);
    expect(mocks.getSoundboardSessionUser).toHaveBeenCalledOnce();
    expect(mocks.getSignedSoundUrl).not.toHaveBeenCalledWith(sound.sourceStoragePath);
    expect(data.currentUser).toEqual({ id: 'user-1', role: 'member' });
    expect(data.sounds).toEqual([{
      id: 'global-sound',
      name: 'Global horn',
      category: 'Reactions',
      color: '#5865f2',
      mimeType: 'audio/wav',
      sizeBytes: 1024,
      durationSec: 1,
      uploadedById: 'user-1',
      uploadedByName: 'Kai',
      shortcut: null,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      trimStartMs: 0,
      trimEndMs: 1000,
      sortOrder: 0,
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      previewUrl: `https://signed.example/${sound.storagePath}`,
      sourcePreviewUrl: null,
    }]);
  });
});
