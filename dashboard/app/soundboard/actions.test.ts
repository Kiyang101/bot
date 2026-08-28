// @vitest-environment node
import assert from 'node:assert/strict';
import { test } from 'vitest';
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
    getAuthorizedGuildIds: async () => ['guild-1'],
    isVoiceChannelInGuild: async () => true,
    listSounds: async () => [ownSound, otherSound],
    getSound: async (id) => (id === ownSound.id ? ownSound : id === otherSound.id ? otherSound : null),
    getSignedSoundUrl: async () => 'https://signed.example/playable',
    uploadSource: async () => ownSound.sourceStoragePath,
    uploadPlayableClip: async () => ownSound.storagePath,
    deleteStorageObject: async () => undefined,
    downloadSource: async () => new Blob(),
    stageSoundFilesForDeletion: async () => ({
      sourceStoragePath: ownSound.sourceStoragePath,
      playableStoragePath: ownSound.storagePath,
      stagedSourcePath: 'sounds/member-1/sound-own/staging/delete-stage/source',
      stagedPlayablePath: 'sounds/member-1/sound-own/staging/delete-stage/playable',
      sourceMimeType: ownSound.mimeType,
    }),
    deleteSoundFiles: async () => undefined,
    restoreSoundFiles: async () => undefined,
    discardSoundFileStage: async () => undefined,
    insertSound: async () => ownSound,
    updateSound: async () => ownSound,
    deleteSoundRow: async () => undefined,
    updateSoundOrder: async () => undefined,
    trimSourceFile: async () => ({ buffer: Buffer.from('clip'), durationSec: 1, sourceDurationSec: 1 }),
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

test('selected guild playback is rejected when it is not in the verified member guild set', async () => {
  let played = false;
  const actions = createSoundboardActions(createDependencies({
    getSelectedGuildId: async () => 'guild-not-member',
    getAuthorizedGuildIds: async () => ['guild-1'],
    sendSoundboardPlay: async () => { played = true; },
  }));

  const result = await actions.playSound({ soundId: ownSound.id, channelId: 'channel-1' });

  assert.deepEqual(result, { ok: false, message: 'You are not a member of the selected server.' });
  assert.equal(played, false);
});

test('stop rejects an unverified selected guild before contacting the bot', async () => {
  let stopped = false;
  const actions = createSoundboardActions(createDependencies({
    getSelectedGuildId: async () => 'guild-not-member',
    getAuthorizedGuildIds: async () => ['guild-1'],
    sendSoundboardStop: async () => { stopped = true; },
  }));

  const result = await actions.stopSound('channel-1');

  assert.deepEqual(result, { ok: false, message: 'You are not a member of the selected server.' });
  assert.equal(stopped, false);
});

test('play and stop validate that the requested channel belongs to the selected guild', async () => {
  const actions = createSoundboardActions(createDependencies({
    isVoiceChannelInGuild: async () => false,
  }));

  assert.deepEqual(
    await actions.playSound({ soundId: ownSound.id, channelId: 'channel-other-guild' }),
    { ok: false, message: 'Pick a voice channel in the selected server.' },
  );
  assert.deepEqual(
    await actions.stopSound('channel-other-guild'),
    { ok: false, message: 'Pick a voice channel in the selected server.' },
  );
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

test('upload rejects unsupported source bytes forged with an allowed MIME label before processing or storage', async () => {
  let trimmed = false;
  let sourceUploaded = false;
  let playableUploaded = false;
  const actions = createSoundboardActions(
    createDependencies({
      trimSourceFile: async () => {
        trimmed = true;
        return { buffer: Buffer.from('clip'), durationSec: 1, sourceDurationSec: 1 };
      },
      uploadSource: async () => {
        sourceUploaded = true;
        return ownSound.sourceStoragePath;
      },
      uploadPlayableClip: async () => {
        playableUploaded = true;
        return ownSound.storagePath;
      },
    }),
  );

  const result = await actions.uploadSound({
    name: 'Forged FLAC',
    category: 'Reactions',
    color: '#5865f2',
    shortcut: null,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    file: {
      type: 'audio/wav',
      size: 4,
      arrayBuffer: async () => new Uint8Array([0x66, 0x4c, 0x61, 0x43]).buffer,
    },
    trimStartMs: 0,
    trimEndMs: 500,
  });

  assert.deepEqual(result, { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' });
  assert.equal(trimmed, false);
  assert.equal(sourceUploaded, false);
  assert.equal(playableUploaded, false);
});

test('upload rejects ID3-prefixed unsupported data before processing or storage', async () => {
  const id3Only = new Uint8Array([
    0x49, 0x44, 0x33,
    0x04, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x04,
    0xde, 0xad, 0xbe, 0xef,
  ]);
  let trimmed = false;
  let sourceUploaded = false;
  let playableUploaded = false;
  const actions = createSoundboardActions(
    createDependencies({
      trimSourceFile: async () => {
        trimmed = true;
        return { buffer: Buffer.from('clip'), durationSec: 1, sourceDurationSec: 1 };
      },
      uploadSource: async () => {
        sourceUploaded = true;
        return ownSound.sourceStoragePath;
      },
      uploadPlayableClip: async () => {
        playableUploaded = true;
        return ownSound.storagePath;
      },
    }),
  );

  const result = await actions.uploadSound({
    name: 'Fake tagged MP3',
    category: 'Reactions',
    color: '#5865f2',
    shortcut: null,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    file: {
      type: 'audio/mpeg',
      size: id3Only.byteLength,
      arrayBuffer: async () => id3Only.buffer,
    },
    trimStartMs: 0,
    trimEndMs: 500,
  });

  assert.deepEqual(result, { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' });
  assert.equal(trimmed, false);
  assert.equal(sourceUploaded, false);
  assert.equal(playableUploaded, false);
});

test('upload rejects a single complete zero-filled MPEG frame before processing or storage', async () => {
  const forgedFrame = new Uint8Array(417);
  forgedFrame.set([0xff, 0xfb, 0x90, 0x00]);
  let trimmed = false;
  let sourceUploaded = false;
  let playableUploaded = false;
  const actions = createSoundboardActions(
    createDependencies({
      trimSourceFile: async () => {
        trimmed = true;
        return { buffer: Buffer.from('clip'), durationSec: 1, sourceDurationSec: 1 };
      },
      uploadSource: async () => {
        sourceUploaded = true;
        return ownSound.sourceStoragePath;
      },
      uploadPlayableClip: async () => {
        playableUploaded = true;
        return ownSound.storagePath;
      },
    }),
  );

  const result = await actions.uploadSound({
    name: 'Forged MPEG frame',
    category: 'Reactions',
    color: '#5865f2',
    shortcut: null,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    file: {
      type: 'audio/mpeg',
      size: forgedFrame.byteLength,
      arrayBuffer: async () => forgedFrame.buffer,
    },
    trimStartMs: 0,
    trimEndMs: 500,
  });

  assert.deepEqual(result, { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' });
  assert.equal(trimmed, false);
  assert.equal(sourceUploaded, false);
  assert.equal(playableUploaded, false);
});

test('trim rejects a truncated MPEG frame before processing or playable storage', async () => {
  const truncatedFrame = new Uint8Array(100);
  truncatedFrame.set([0xff, 0xfb, 0x90, 0x00]);
  let trimmed = false;
  let playableUploaded = false;
  const actions = createSoundboardActions(
    createDependencies({
      downloadSource: async () => new Blob([truncatedFrame], { type: 'audio/mpeg' }),
      trimSourceFile: async () => {
        trimmed = true;
        return { buffer: Buffer.from('clip'), durationSec: 1, sourceDurationSec: 1 };
      },
      uploadPlayableClip: async () => {
        playableUploaded = true;
        return ownSound.storagePath;
      },
    }),
  );

  const result = await actions.trimSound({
    soundId: ownSound.id,
    trimStartMs: 0,
    trimEndMs: 500,
  });

  assert.deepEqual(result, { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' });
  assert.equal(trimmed, false);
  assert.equal(playableUploaded, false);
});

test('trim rejects a single complete zero-filled MPEG frame before processing or playable storage', async () => {
  const forgedFrame = new Uint8Array(417);
  forgedFrame.set([0xff, 0xfb, 0x90, 0x00]);
  let trimmed = false;
  let playableUploaded = false;
  const actions = createSoundboardActions(
    createDependencies({
      downloadSource: async () => new Blob([forgedFrame], { type: 'audio/mpeg' }),
      trimSourceFile: async () => {
        trimmed = true;
        return { buffer: Buffer.from('clip'), durationSec: 1, sourceDurationSec: 1 };
      },
      uploadPlayableClip: async () => {
        playableUploaded = true;
        return ownSound.storagePath;
      },
    }),
  );

  const result = await actions.trimSound({
    soundId: ownSound.id,
    trimStartMs: 0,
    trimEndMs: 500,
  });

  assert.deepEqual(result, { ok: false, message: 'Sound must be an MP3, WAV, or OGG file.' });
  assert.equal(trimmed, false);
  assert.equal(playableUploaded, false);
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

test('delete restores both storage objects when deleting the database row fails', async () => {
  let filesPresent = true;
  let restored = false;
  const actions = createSoundboardActions(createDependencies({
    deleteSoundFiles: async () => { filesPresent = false; },
    deleteSoundRow: async () => { throw new Error('database unavailable'); },
    restoreSoundFiles: async () => { filesPresent = true; restored = true; },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.deepEqual(result, { ok: false, message: 'Failed to delete sound.' });
  assert.equal(restored, true);
  assert.equal(filesPresent, true);
});

test('delete restores staged files and leaves the row when storage deletion fails', async () => {
  let rowDeleted = false;
  let restored = false;
  const actions = createSoundboardActions(createDependencies({
    deleteSoundFiles: async () => { throw new Error('storage unavailable'); },
    deleteSoundRow: async () => { rowDeleted = true; },
    restoreSoundFiles: async () => { restored = true; },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.deepEqual(result, { ok: false, message: 'Failed to delete sound.' });
  assert.equal(restored, true);
  assert.equal(rowDeleted, false);
});

test('trim uploads a versioned clip and removes only that staged version when the row update fails', async () => {
  const removedPaths: string[] = [];
  let uploadedPath = '';
  const actions = createSoundboardActions(createDependencies({
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    uploadPlayableClip: async () => {
      uploadedPath = 'sounds/member-1/sound-own/playable-version-2';
      return uploadedPath;
    },
    updateSound: async () => { throw new Error('database unavailable'); },
    deleteStorageObject: async (path) => { removedPaths.push(path); },
    trimSourceFile: async () => ({ buffer: Buffer.from('new clip'), durationSec: 0.4, sourceDurationSec: 1 }),
  }));

  const result = await actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 });

  assert.deepEqual(result, { ok: false, message: 'Failed to trim sound.' });
  assert.deepEqual(removedPaths, [uploadedPath]);
  assert.notEqual(uploadedPath, ownSound.storagePath);
});

test('upload persists server-measured playable duration instead of the browser duration', async () => {
  let insertedDurationSec: number | null = null;
  const wavHeader = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
  ]);
  const actions = createSoundboardActions(createDependencies({
    insertSound: async (input) => {
      insertedDurationSec = input.durationSec;
      return { ...ownSound, ...input };
    },
    trimSourceFile: async () => ({ buffer: Buffer.from('clip'), durationSec: 0.42, sourceDurationSec: 0.75 }),
  }));

  const result = await actions.uploadSound({
    name: 'Measured', category: 'Reactions', color: '#5865f2', shortcut: null,
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
    file: { type: 'audio/wav', size: wavHeader.byteLength, arrayBuffer: async () => wavHeader.buffer },
    trimStartMs: 0,
    trimEndMs: 500,
  });

  assert.equal(result.ok, true);
  assert.equal(insertedDurationSec, 0.42);
});

test('trim persists measured playable duration with the new immutable storage path', async () => {
  let update: Parameters<SoundboardActionDependencies['updateSound']>[1] | null = null;
  const newPath = 'sounds/member-1/sound-own/playable-version-2';
  const actions = createSoundboardActions(createDependencies({
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    uploadPlayableClip: async () => newPath,
    trimSourceFile: async () => ({ buffer: Buffer.from('clip'), durationSec: 0.41, sourceDurationSec: 1 }),
    updateSound: async (_id, input) => {
      update = input;
      return { ...ownSound, ...input };
    },
  }));

  const result = await actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 });

  assert.equal(result.ok, true);
  assert.deepEqual(update, {
    storagePath: newPath,
    trimStartMs: 100,
    trimEndMs: 500,
    durationSec: 0.41,
  });
});

test('trim retries superseded clip cleanup and reports a sanitized warning when it remains unavailable', async () => {
  let cleanupAttempts = 0;
  const actions = createSoundboardActions(createDependencies({
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    uploadPlayableClip: async () => 'sounds/member-1/sound-own/playable-version-2',
    trimSourceFile: async () => ({ buffer: Buffer.from('clip'), durationSec: 0.41, sourceDurationSec: 1 }),
    deleteStorageObject: async () => {
      cleanupAttempts += 1;
      throw new Error('storage path leaked in provider response');
    },
    updateSound: async (_id, input) => ({ ...ownSound, ...input }),
  }));

  const result = await actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 });

  assert.equal(result.ok, true);
  assert.equal(cleanupAttempts, 3);
  assert.equal('warning' in result, true);
  assert.match('warning' in result ? result.warning ?? '' : '', /cleanup/i);
  assert.doesNotMatch(JSON.stringify(result), /sounds\//);
});

test('delete retries staging cleanup and reports a sanitized warning after the row is removed', async () => {
  let discardAttempts = 0;
  const actions = createSoundboardActions(createDependencies({
    discardSoundFileStage: async () => {
      discardAttempts += 1;
      throw new Error('private staging path should not be exposed');
    },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.equal(result.ok, true);
  assert.equal(discardAttempts, 3);
  assert.equal('warning' in result, true);
  assert.match('warning' in result ? result.warning ?? '' : '', /cleanup/i);
  assert.doesNotMatch(JSON.stringify(result), /sounds\//);
});

test('duplicate shortcuts are rejected before mutation and identify the conflicting sound', async () => {
  let updated = false;
  const conflict = { ...otherSound, name: 'Airhorn', shortcut: 'k' };
  const actions = createSoundboardActions(createDependencies({
    listSounds: async () => [ownSound, conflict],
    updateSound: async () => { updated = true; return ownSound; },
  }));

  const result = await actions.updateSound(ownSound.id, {
    name: ownSound.name, category: ownSound.category, color: ownSound.color, shortcut: 'K',
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
  });

  assert.deepEqual(result, { ok: false, message: 'Shortcut K is already assigned to Airhorn.' });
  assert.equal(updated, false);
});

test('members cannot submit custom categories or non-preset colors directly', async () => {
  let updated = false;
  const actions = createSoundboardActions(createDependencies({
    updateSound: async () => { updated = true; return ownSound; },
  }));

  const customCategory = await actions.updateSound(ownSound.id, {
    name: ownSound.name, category: 'Secret category', color: '#5865f2', shortcut: null,
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
  });
  const customColor = await actions.updateSound(ownSound.id, {
    name: ownSound.name, category: 'Reactions', color: '#123456', shortcut: null,
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
  });

  assert.deepEqual(customCategory, { ok: false, message: 'Members may only use the shared sound categories.' });
  assert.deepEqual(customColor, { ok: false, message: 'Choose one of the preset sound colors.' });
  assert.equal(updated, false);
});

test('admins may submit a custom category but still must use a preset color', async () => {
  const adminSound = { ...ownSound, uploadedById: 'member-2' };
  let updateInput: { category?: string } | null = null;
  const actions = createSoundboardActions(createDependencies({
    getSessionUser: async () => ({ id: 'admin-1', username: 'Admin', avatar: null, role: 'admin' }),
    getSound: async () => adminSound,
    updateSound: async (_id, input) => { updateInput = input; return { ...adminSound, ...input }; },
  }));

  const result = await actions.updateSound(adminSound.id, {
    name: adminSound.name, category: 'Tournament', color: '#faa61a', shortcut: null,
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal((updateInput as { category?: string } | null)?.category, 'Tournament');
});

test('serializes concurrent trims so each superseded playable clip is cleaned up', async () => {
  let current = ownSound as import('@/lib/sound-types').SoundRecord;
  let inFlight = 0;
  let maxInFlight = 0;
  let version = 1;
  const deleted: string[] = [];
  const actions = createSoundboardActions(createDependencies({
    getSound: async () => current,
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    trimSourceFile: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { buffer: Buffer.from('clip'), durationSec: 0.4, sourceDurationSec: 1 };
    },
    uploadPlayableClip: async () => `sounds/member-1/sound-own/playable-version-${version++}`,
    updateSound: async (_id, input) => {
      current = { ...current, ...input };
      return current;
    },
    deleteStorageObject: async (path) => { deleted.push(path); },
  }));

  await Promise.all([
    actions.trimSound({ soundId: ownSound.id, trimStartMs: 0, trimEndMs: 400 }),
    actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 }),
  ]);

  assert.equal(maxInFlight, 1);
  assert.deepEqual(deleted.sort(), [
    ownSound.storagePath,
    'sounds/member-1/sound-own/playable-version-1',
  ].sort());
});

test('a shortcut uniqueness race is sanitized and identifies the newly conflicting sound', async () => {
  const conflict = { ...otherSound, name: 'Airhorn', shortcut: 'k' };
  let listCalls = 0;
  const actions = createSoundboardActions(createDependencies({
    listSounds: async () => (++listCalls === 1 ? [ownSound] : [ownSound, conflict]),
    updateSound: async () => { throw new Error('duplicate key value violates unique constraint "Sound_shortcut_key"'); },
  }));

  const result = await actions.updateSound(ownSound.id, {
    name: ownSound.name, category: ownSound.category, color: ownSound.color, shortcut: 'k',
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
  });

  assert.deepEqual(result, { ok: false, message: 'Shortcut K is already assigned to Airhorn.' });
});

test('unexpected mutation failures return a stable message without internal details', async () => {
  const actions = createSoundboardActions(createDependencies({
    updateSound: async () => { throw new Error('postgres://secret@database: password leaked'); },
  }));

  const result = await actions.updateSound(ownSound.id, {
    name: ownSound.name, category: ownSound.category, color: ownSound.color, shortcut: null,
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
  });

  assert.deepEqual(result, { ok: false, message: 'Failed to update sound.' });
});

test('source URLs require owner-or-admin authorization while playable URLs require authentication', async () => {
  let signed = 0;
  const memberActions = createSoundboardActions(createDependencies({
    getSignedSoundUrl: async () => { signed += 1; return 'https://signed.example/refreshed'; },
  }));

  assert.deepEqual(
    await memberActions.getSoundSourceUrl(otherSound.id),
    { ok: false, message: 'You can only modify your own sounds.' },
  );
  assert.deepEqual(
    await memberActions.getSoundPlayableUrl(otherSound.id),
    { ok: true, value: 'https://signed.example/refreshed' },
  );
  assert.equal(signed, 1);

  const adminActions = createSoundboardActions(createDependencies({
    getSessionUser: async () => ({ id: 'admin-1', username: 'Admin', avatar: null, role: 'admin' }),
    getSignedSoundUrl: async () => 'https://signed.example/source',
  }));
  assert.deepEqual(
    await adminActions.getSoundSourceUrl(otherSound.id),
    { ok: true, value: 'https://signed.example/source' },
  );
});

test('reorder delegates the verified complete order to one atomic persistence call', async () => {
  const orders: string[][] = [];
  const actions = createSoundboardActions(createDependencies({
    getSessionUser: async () => ({ id: 'admin-1', username: 'Admin', avatar: null, role: 'admin' }),
    updateSoundOrder: async (ids) => { orders.push(ids); },
  }));

  const result = await actions.reorderSounds([otherSound.id, ownSound.id]);

  assert.equal(result.ok, true);
  assert.deepEqual(orders, [[otherSound.id, ownSound.id]]);
});
