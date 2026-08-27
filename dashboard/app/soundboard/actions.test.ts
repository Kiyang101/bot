import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSoundboardActions,
  type SoundboardActionDependencies,
} from './actions';
import { SoundboardBusyError, SOUNDBOARD_BUSY_MESSAGE, sendSoundboardPlay } from '../../lib/control';

const ownSound = {
  id: 'sound-own',
  name: 'Airhorn',
  category: 'Reactions',
  color: '#5865f2',
  storagePath: 'sounds/member-1/sound-own/playable',
  sourceStoragePath: 'sounds/member-1/sound-own/source',
  mimeType: 'audio/wav',
  sizeBytes: 800,
  durationSec: 1,
  uploadedById: 'member-1',
  uploadedByName: 'Member One',
  shortcut: null,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  trimStartMs: 0,
  trimEndMs: 1_000,
  sortOrder: 0,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

const otherSound = { ...ownSound, id: 'sound-other', uploadedById: 'member-2' };

function createDependencies(overrides: Partial<SoundboardActionDependencies> = {}): SoundboardActionDependencies {
  return {
    getSessionUser: async () => ({ id: 'member-1', username: 'Member One', avatar: null, role: 'member' }),
    getSelectedGuildId: async () => 'guild-1',
    listSounds: async () => [ownSound, otherSound],
    getSound: async (id) => (id === ownSound.id ? ownSound : id === otherSound.id ? otherSound : null),
    getSignedSoundUrl: async () => 'https://signed.example/playable',
    uploadSource: async () => ownSound.sourceStoragePath,
    replacePlayableClip: async () => ownSound.storagePath,
    downloadSource: async () => new Blob(),
    deleteSoundFiles: async () => undefined,
    insertSound: async () => ownSound,
    updateSound: async () => ownSound,
    deleteSoundRow: async () => undefined,
    updateSoundSortOrder: async () => undefined,
    trimSourceFile: async () => ({ buffer: Buffer.from('clip'), durationSec: 1 }),
    sendSoundboardPlay: async () => undefined,
    sendSoundboardStop: async () => undefined,
    revalidatePath: () => undefined,
    createSoundId: () => 'sound-new',
    ...overrides,
  };
}

test('a member can delete their own global sound', async () => {
  const deleted: string[] = [];
  const actions = createSoundboardActions(
    createDependencies({ deleteSoundRow: async (id) => void deleted.push(id) }),
  );

  const result = await actions.deleteSound(ownSound.id);

  assert.equal(result.ok, true);
  assert.deepEqual(deleted, [ownSound.id]);
});

test('a member cannot delete another member\'s global sound', async () => {
  const deleted: string[] = [];
  const actions = createSoundboardActions(
    createDependencies({ deleteSoundRow: async (id) => void deleted.push(id) }),
  );

  const result = await actions.deleteSound(otherSound.id);

  assert.deepEqual(result, { ok: false, message: 'You can only modify your own sounds.' });
  assert.deepEqual(deleted, []);
});

test('an admin can delete another member\'s global sound', async () => {
  const deleted: string[] = [];
  const actions = createSoundboardActions(
    createDependencies({
      getSessionUser: async () => ({ id: 'admin-1', username: 'Admin', avatar: null, role: 'admin' }),
      deleteSoundRow: async (id) => void deleted.push(id),
    }),
  );

  const result = await actions.deleteSound(otherSound.id);

  assert.equal(result.ok, true);
  assert.deepEqual(deleted, [otherSound.id]);
});

test('all authenticated users can play a global sound', async () => {
  const plays: unknown[] = [];
  const actions = createSoundboardActions(
    createDependencies({ sendSoundboardPlay: async (payload) => void plays.push(payload) }),
  );

  const result = await actions.playSound({ soundId: otherSound.id, channelId: 'channel-1' });

  assert.equal(result.ok, true);
  assert.deepEqual(plays, [
    {
      guildId: 'guild-1',
      channelId: 'channel-1',
      audioUrl: 'https://signed.example/playable',
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
    },
  ]);
});

test('a missing selected guild blocks playback but not global listing', async () => {
  let played = false;
  const actions = createSoundboardActions(
    createDependencies({
      getSelectedGuildId: async () => null,
      sendSoundboardPlay: async () => {
        played = true;
      },
    }),
  );

  const data = await actions.listSoundboardData();
  const result = await actions.playSound({ soundId: ownSound.id, channelId: 'channel-1' });

  assert.equal(data.sounds.length, 2);
  assert.equal('storagePath' in data.sounds[0], false);
  assert.deepEqual(result, { ok: false, message: 'No server selected.' });
  assert.equal(played, false);
});

test('a sound id outside the global table is rejected', async () => {
  let signed = false;
  const actions = createSoundboardActions(
    createDependencies({
      getSignedSoundUrl: async () => {
        signed = true;
        return 'https://signed.example/playable';
      },
    }),
  );

  const result = await actions.playSound({ soundId: 'not-a-global-sound', channelId: 'channel-1' });

  assert.deepEqual(result, { ok: false, message: 'Sound not found.' });
  assert.equal(signed, false);
});

test('a busy control response becomes a typed soundboard busy error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'soundboard_busy' }), { status: 409 });

  try {
    await assert.rejects(
      sendSoundboardPlay({
        guildId: 'guild-1',
        channelId: 'channel-1',
        audioUrl: 'https://signed.example/playable',
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
      }),
      (error: unknown) => error instanceof SoundboardBusyError && error.message === SOUNDBOARD_BUSY_MESSAGE,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
