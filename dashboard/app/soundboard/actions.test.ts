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
    canMemberUseVoiceChannel: async () => true,
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
    acquireSoundMutation: async (_soundId, _operation, token) => ({ token, mutationVersion: 1 }),
    releaseSoundMutation: async () => undefined,
    prepareSoundTrimMutation: async () => undefined,
    markSoundMutationRecovery: async () => undefined,
    completeSoundMutationRecovery: async () => undefined,
    prepareSoundUploadRecovery: async () => undefined,
    markSoundUploadRecoveryPending: async () => undefined,
    completeSoundUploadRecovery: async () => undefined,
    commitSoundTrim: async (input) => {
      const update = overrides.updateSound ?? (async () => ownSound);
      return update(input.soundId, {
        storagePath: input.storagePath,
        trimStartMs: input.trimStartMs,
        trimEndMs: input.trimEndMs,
        durationSec: input.durationSec,
      });
    },
    commitSoundDelete: async (input) => {
      const deleteRow = overrides.deleteSoundRow ?? (async () => undefined);
      await deleteRow(input.soundId);
      return true;
    },
    enqueueSoundCleanup: async () => undefined,
    reconcileSoundMutationRecoveries: async () => ({ processed: 0, deferred: 0 }),
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
    canMemberUseVoiceChannel: async () => false,
  }));

  assert.deepEqual(
    await actions.playSound({ soundId: ownSound.id, channelId: 'channel-other-guild' }),
    { ok: false, message: 'Pick a voice channel you can view and connect to in the selected server.' },
  );
  assert.deepEqual(
    await actions.stopSound('channel-other-guild'),
    { ok: false, message: 'Pick a voice channel you can view and connect to in the selected server.' },
  );
});

test('play and stop reject a channel the requesting Discord member cannot view and connect to', async () => {
  let played = false;
  let stopped = false;
  const actions = createSoundboardActions(createDependencies({
    canMemberUseVoiceChannel: async () => false,
    sendSoundboardPlay: async () => { played = true; },
    sendSoundboardStop: async () => { stopped = true; },
  }));

  assert.deepEqual(
    await actions.playSound({ soundId: ownSound.id, channelId: 'private-voice' }),
    { ok: false, message: 'Pick a voice channel you can view and connect to in the selected server.' },
  );
  assert.deepEqual(
    await actions.stopSound('private-voice'),
    { ok: false, message: 'Pick a voice channel you can view and connect to in the selected server.' },
  );
  assert.equal(played, false);
  assert.equal(stopped, false);
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

test('upload persists cleanup intent before uploads and keeps paths recoverable when cleanup also fails', async () => {
  const events: string[] = [];
  let uploadIntent: Record<string, unknown> | null = null;
  const sourcePath = 'sounds/member-1/sound-new/source';
  const playablePath = 'sounds/member-1/sound-new/playable-sound-new';
  const wav = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
  ]);
  const actions = createSoundboardActions(createDependencies({
    prepareSoundUploadRecovery: async (input) => {
      events.push('prepare');
      uploadIntent = input as unknown as Record<string, unknown>;
    },
    uploadSource: async () => {
      events.push('source-upload');
      return sourcePath;
    },
    uploadPlayableClip: async () => {
      events.push('playable-upload');
      return playablePath;
    },
    insertSound: async () => { throw new Error('database unavailable'); },
    deleteStorageObject: async () => { throw new Error('storage unavailable'); },
    enqueueSoundCleanup: async () => { throw new Error('cleanup queue unavailable'); },
    trimSourceFile: async () => ({ buffer: Buffer.from('clip'), durationSec: 0.4, sourceDurationSec: 1 }),
  }));

  const result = await actions.uploadSound({
    name: 'Recoverable', category: 'Reactions', color: '#5865f2', shortcut: null,
    gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
    file: { type: 'audio/wav', size: wav.byteLength, arrayBuffer: async () => wav.buffer },
    trimStartMs: 0,
    trimEndMs: 500,
  });

  assert.deepEqual(events, ['prepare', 'source-upload', 'playable-upload']);
  assert.deepEqual(uploadIntent, {
    soundId: 'sound-new',
    uploadedById: 'member-1',
    sourceStoragePath: sourcePath,
    playableStoragePath: playablePath,
  });
  assert.deepEqual(result, {
    ok: false,
    message: 'Failed to upload sound.',
    warning: 'Audio cleanup could not be completed. Please retry or contact an administrator.',
    recoveryRequired: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /sounds\//);
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
  let restoredMime: string | null = null;
  const actions = createSoundboardActions(createDependencies({
    getSound: async () => ({ ...ownSound, mimeType: 'audio/ogg' }),
    stageSoundFilesForDeletion: async ({ sound }) => ({
      sourceStoragePath: sound.sourceStoragePath,
      playableStoragePath: sound.storagePath,
      stagedSourcePath: 'sounds/member-1/sound-own/staging/delete-stage/source',
      stagedPlayablePath: 'sounds/member-1/sound-own/staging/delete-stage/playable',
      sourceMimeType: sound.mimeType,
    }),
    deleteSoundFiles: async () => { filesPresent = false; },
    deleteSoundRow: async () => { throw new Error('database unavailable'); },
    restoreSoundFiles: async (stage) => {
      filesPresent = true;
      restored = true;
      restoredMime = stage.sourceMimeType;
    },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.deepEqual(result, { ok: false, message: 'Failed to delete sound.' });
  assert.equal(restored, true);
  assert.equal(filesPresent, true);
  assert.equal(restoredMime, 'audio/ogg');
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

test('partial delete restore retains staging and returns a recovery-required result', async () => {
  let discarded = false;
  let queued = false;
  const actions = createSoundboardActions(createDependencies({
    deleteSoundFiles: async () => { throw new Error('storage unavailable'); },
    restoreSoundFiles: async () => ({ sourceRestored: true, playableRestored: false }),
    discardSoundFileStage: async () => { discarded = true; },
    enqueueSoundCleanup: async () => { queued = true; },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.deepEqual(result, {
    ok: false,
    message: 'Failed to delete sound.',
    recoveryRequired: true,
    warning: 'Audio cleanup could not be completed. Please retry or contact an administrator.',
  });
  assert.equal(discarded, false);
  assert.equal(queued, false);
});

test('cleanup queue enqueue failure is surfaced as recovery-required', async () => {
  const actions = createSoundboardActions(createDependencies({
    discardSoundFileStage: async () => { throw new Error('storage unavailable'); },
    enqueueSoundCleanup: async () => { throw new Error('database unavailable'); },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.equal(result.ok, true);
  assert.equal('recoveryRequired' in result && result.recoveryRequired, true);
  assert.match('warning' in result ? result.warning ?? '' : '', /cleanup/i);
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

test('trim persists its recovery record before uploading the generated clip', async () => {
  const events: string[] = [];
  const actions = createSoundboardActions(createDependencies({
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    prepareSoundTrimMutation: async () => { events.push('prepare'); },
    uploadPlayableClip: async () => { events.push('upload'); return 'sounds/member-1/sound-own/playable-version-2'; },
  }));

  await actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 });

  assert.deepEqual(events, ['prepare', 'upload']);
});

test('trim persists the complete replay intent before generated upload', async () => {
  let prepared: Record<string, unknown> | null = null;
  const generatedPath = 'sounds/member-1/sound-own/playable-sound-new';
  const actions = createSoundboardActions(createDependencies({
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    prepareSoundTrimMutation: async (input) => {
      prepared = input as unknown as Record<string, unknown>;
    },
    uploadPlayableClip: async () => generatedPath,
    trimSourceFile: async () => ({ buffer: Buffer.from('measured-clip'), durationSec: 0.42, sourceDurationSec: 0.75 }),
  }));

  const result = await actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 });

  assert.equal(result.ok, true);
  assert.deepEqual(prepared, {
    soundId: ownSound.id,
    lease: { token: 'sound-new', mutationVersion: 1 },
    versionId: 'sound-new',
    previousPlayablePath: ownSound.storagePath,
    sourceStoragePath: ownSound.sourceStoragePath,
    generatedStoragePath: generatedPath,
    trimStartMs: 100,
    trimEndMs: 500,
    sourceDurationSec: 0.75,
    generatedDurationSec: 0.42,
    sourceMimeType: 'audio/wav',
    generatedMimeType: 'audio/wav',
    sourceSizeBytes: 12,
    generatedSizeBytes: Buffer.byteLength('measured-clip'),
  });
});

test('delete staging failures return recovery-required without discarding partial copies', async () => {
  let recoveryRequired = false;
  const stagingError = Object.assign(new Error('private storage details'), { recoveryRequired: true });
  const actions = createSoundboardActions(createDependencies({
    stageSoundFilesForDeletion: async () => { throw stagingError; },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.deepEqual(result, {
    ok: false,
    message: 'Failed to delete sound.',
    recoveryRequired: true,
  });
  recoveryRequired = result.ok === false && result.recoveryRequired === true;
  assert.equal(recoveryRequired, true);
});

test('trim cleanup queue failure remains a sanitized recovery-required result', async () => {
  const generatedPath = 'sounds/member-1/sound-own/playable-stale';
  const actions = createSoundboardActions(createDependencies({
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    uploadPlayableClip: async () => generatedPath,
    commitSoundTrim: async () => null,
    deleteStorageObject: async () => { throw new Error('storage path must stay private'); },
    enqueueSoundCleanup: async () => { throw new Error('database unavailable'); },
  }));

  const result = await actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 });

  assert.deepEqual(result, {
    ok: false,
    message: 'Sound changed while trim was in progress. Please retry.',
    warning: 'Audio cleanup could not be completed. Please retry or contact an administrator.',
    recoveryRequired: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /sounds\//);
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

test('stale trim CAS is rejected and failed generated-clip cleanup is durably queued', async () => {
  const queued: Array<{ soundId: string | null; objectPath: string; cleanupKind: string }> = [];
  const generatedPath = 'sounds/member-1/sound-own/playable-stale';
  const actions = createSoundboardActions(createDependencies({
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    uploadPlayableClip: async () => generatedPath,
    commitSoundTrim: async () => null,
    deleteStorageObject: async () => { throw new Error('private provider path'); },
    enqueueSoundCleanup: async (input) => { queued.push(input); },
  }));

  const result = await actions.trimSound({ soundId: ownSound.id, trimStartMs: 100, trimEndMs: 500 });

  assert.deepEqual(result, {
    ok: false,
    message: 'Sound changed while trim was in progress. Please retry.',
    warning: 'Audio cleanup could not be completed. Please retry or contact an administrator.',
  });
  assert.deepEqual(queued, [{ soundId: ownSound.id, objectPath: generatedPath, cleanupKind: 'delete_object' }]);
  assert.doesNotMatch(JSON.stringify(result), /sounds\//);
});

test('stale delete CAS is rejected, restores staged files, and does not delete the row', async () => {
  let restored = false;
  let rowDeleteCalled = false;
  const actions = createSoundboardActions(createDependencies({
    commitSoundDelete: async () => false,
    deleteSoundRow: async () => { rowDeleteCalled = true; },
    restoreSoundFiles: async () => { restored = true; },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.deepEqual(result, { ok: false, message: 'Failed to delete sound.' });
  assert.equal(restored, true);
  assert.equal(rowDeleteCalled, false);
});

test('stale delete queues its superseded playable object after another trim wins', async () => {
  let reads = 0;
  let restored = false;
  const queued: Array<{ objectPath: string; cleanupKind: string }> = [];
  const currentSound = { ...ownSound, storagePath: 'sounds/member-1/sound-own/playable-new' };
  const actions = createSoundboardActions(createDependencies({
    getSound: async () => (++reads < 3 ? ownSound : currentSound),
    commitSoundDelete: async () => false,
    restoreSoundFiles: async () => { restored = true; },
    enqueueSoundCleanup: async ({ objectPath, cleanupKind }) => { queued.push({ objectPath, cleanupKind }); },
  }));

  const result = await actions.deleteSound(ownSound.id);

  assert.deepEqual(result, { ok: false, message: 'Failed to delete sound.' });
  assert.equal(restored, true);
  assert.deepEqual(queued, [{ objectPath: ownSound.storagePath, cleanupKind: 'delete_object' }]);
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

test('normalizes a literal space shortcut to the server-supported Space token', async () => {
  let updateInput: { shortcut?: string | null } = {};
  const actions = createSoundboardActions(createDependencies({
    updateSound: async (_id, input) => {
      updateInput = input;
      return { ...ownSound, ...input };
    },
  }));

  const result = await actions.updateSound(ownSound.id, {
    name: ownSound.name,
    category: ownSound.category,
    color: ownSound.color,
    shortcut: ' ',
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(updateInput.shortcut, 'space');
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

test('a member can save an owned sound while retaining an admin-assigned custom category', async () => {
  const customSound = { ...ownSound, category: 'Tournament' };
  let updateInput: { category?: string } | null = null;
  const actions = createSoundboardActions(createDependencies({
    getSound: async () => customSound,
    updateSound: async (_id, input) => { updateInput = input; return { ...customSound, ...input }; },
  }));

  const result = await actions.updateSound(customSound.id, {
    name: customSound.name,
    category: customSound.category,
    color: customSound.color,
    shortcut: null,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal((updateInput as { category?: string } | null)?.category, 'Tournament');
});

test('a member cannot change an owned custom category to a new custom category', async () => {
  const customSound = { ...ownSound, category: 'Tournament' };
  let updated = false;
  const actions = createSoundboardActions(createDependencies({
    getSound: async () => customSound,
    updateSound: async () => { updated = true; return customSound; },
  }));

  const result = await actions.updateSound(customSound.id, {
    name: customSound.name,
    category: 'New private category',
    color: customSound.color,
    shortcut: null,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
  });

  assert.deepEqual(result, { ok: false, message: 'Members may only use the shared sound categories or retain the existing custom category.' });
  assert.equal(updated, false);
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

test('serializes trim and delete so delete stages the committed playable clip', async () => {
  let current = ownSound as import('@/lib/sound-types').SoundRecord;
  let releaseTrim!: () => void;
  let trimStarted!: () => void;
  const trimGate = new Promise<void>((resolve) => { releaseTrim = resolve; });
  const started = new Promise<void>((resolve) => { trimStarted = resolve; });
  const stagedPaths: string[] = [];
  const actions = createSoundboardActions(createDependencies({
    getSound: async () => current,
    downloadSource: async () => new Blob([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ])]),
    trimSourceFile: async () => {
      trimStarted();
      await trimGate;
      return { buffer: Buffer.from('new-clip'), durationSec: 0.4, sourceDurationSec: 1 };
    },
    uploadPlayableClip: async () => 'sounds/member-1/sound-own/playable-version-2',
    updateSound: async (_id, input) => {
      current = { ...current, ...input };
      return current;
    },
    stageSoundFilesForDeletion: async ({ sound }) => {
      stagedPaths.push(sound.storagePath);
      return {
        sourceStoragePath: sound.sourceStoragePath,
        playableStoragePath: sound.storagePath,
        stagedSourcePath: 'sounds/member-1/sound-own/staging/delete/source',
        stagedPlayablePath: 'sounds/member-1/sound-own/staging/delete/playable',
        sourceMimeType: sound.mimeType,
      };
    },
  }));

  const trimming = actions.trimSound({ soundId: ownSound.id, trimStartMs: 0, trimEndMs: 400 });
  await started;
  const deleting = actions.deleteSound(ownSound.id);
  await Promise.resolve();
  assert.deepEqual(stagedPaths, []);
  releaseTrim();

  const [trimResult, deleteResult] = await Promise.all([trimming, deleting]);
  assert.equal(trimResult.ok, true);
  assert.equal(deleteResult.ok, true);
  assert.deepEqual(stagedPaths, ['sounds/member-1/sound-own/playable-version-2']);
});

test('trim and delete acquire durable per-sound coordination before storage work', async () => {
  const acquired: string[] = [];
  const dependencies = createDependencies({
    acquireSoundMutation: async (soundId: string, _operation: 'trim' | 'delete', token: string) => {
      acquired.push(`${soundId}:${token}`);
      return { token, mutationVersion: 1 };
    },
  } as Partial<SoundboardActionDependencies>);
  const actions = createSoundboardActions(dependencies);

  await actions.trimSound({ soundId: ownSound.id, trimStartMs: 0, trimEndMs: 400 });
  await actions.deleteSound(ownSound.id);

  assert.equal(acquired.length, 2);
  assert.equal(acquired.every((item) => item.startsWith(`${ownSound.id}:`)), true);
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
