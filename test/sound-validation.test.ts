import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SOUND_BYTES, canDeleteSound, canEditSound, mapSoundRow, normalizeShortcut, validateTrimRange, validateUploadMeta } from '../dashboard/lib/sound-validation';

test('accepts supported audio metadata and trims the name', () => {
  assert.deepEqual(validateUploadMeta('  Airhorn  ', 'audio/mpeg', 1200), { ok: true, value: { name: 'Airhorn' } });
});

test('rejects unsupported, oversized, and empty uploads', () => {
  assert.equal(validateUploadMeta('clip', 'audio/flac', 1200).ok, false);
  assert.equal(validateUploadMeta('clip', 'audio/mpeg', MAX_SOUND_BYTES + 1).ok, false);
  assert.equal(validateUploadMeta('   ', 'audio/mpeg', 1200).ok, false);
});

test('requires a positive trim range inside the source duration', () => {
  assert.equal(validateTrimRange({ trimStartMs: 100, trimEndMs: 900, sourceDurationMs: 1000 }).ok, true);
  assert.equal(validateTrimRange({ trimStartMs: 900, trimEndMs: 100, sourceDurationMs: 1000 }).ok, false);
  assert.equal(validateTrimRange({ trimStartMs: 0, trimEndMs: 1200, sourceDurationMs: 1000 }).ok, false);
});

test('normalizes printable shortcuts and rejects modifiers', () => {
  assert.equal(normalizeShortcut('A'), 'a');
  assert.equal(normalizeShortcut(' '), 'space');
  assert.equal(normalizeShortcut('Ctrl+K'), null);
});

test('members mutate only their own sounds while admins mutate any sound', () => {
  const own = { uploadedById: 'member-1' };
  const other = { uploadedById: 'member-2' };
  assert.equal(canEditSound({ id: 'member-1', role: 'member' }, own), true);
  assert.equal(canDeleteSound({ id: 'member-1', role: 'member' }, other), false);
  assert.equal(canEditSound({ id: 'admin-1', role: 'admin' }, other), true);
});

test('maps global rows and preserves explicit nullable camelCase values', () => {
  const sound = mapSoundRow({
    id: 'sound-1',
    name: 'Airhorn',
    category: 'Reactions',
    color: '#5865f2',
    storagePath: 'sounds/member-1/sound-1/playable',
    sourceStoragePath: 'sounds/member-1/sound-1/source',
    mimeType: 'audio/mpeg',
    sizeBytes: 1200,
    durationSec: null,
    uploadedById: 'member-1',
    uploadedByName: 'Kai',
    shortcut: null,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    trimStartMs: 0,
    trimEndMs: 100,
    sortOrder: 0,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
  assert.equal(sound.uploadedById, 'member-1');
  assert.equal('guildId' in sound, false);
  assert.equal(sound.durationSec, null);
  assert.equal(sound.shortcut, null);
});
