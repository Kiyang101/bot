import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSupportedAudioMimeType, estimateNormalizedWavBytes, trimSourceFile } from './audio';
import { mapSoundRow } from './sound-validation';

function createMpeg1Layer3Frame(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
}

function createRawMp3(): Buffer {
  return Buffer.concat([createMpeg1Layer3Frame(), createMpeg1Layer3Frame()]);
}

function createId3TaggedMp3(): Buffer {
  const tag = Buffer.from([
    0x49, 0x44, 0x33,
    0x04, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03,
    0x01, 0x02, 0x03,
  ]);
  return Buffer.concat([tag, createRawMp3()]);
}

function createWavFixture(durationMs: number): Buffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = Math.floor((sampleRate * durationMs) / 1_000) * channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

test('maps a global sound row without guild ownership', () => {
  const row = { id: 's1', name: 'Airhorn', uploadedById: 'u1', uploadedByName: 'Kai', sortOrder: 0 };
  assert.equal(mapSoundRow(row as never).uploadedById, 'u1');
  assert.equal('guildId' in mapSoundRow(row as never), false);
});

test('trim processing rejects an end before start', async () => {
  await assert.rejects(
    trimSourceFile({
      source: createWavFixture(500),
      mimeType: 'audio/wav',
      trimStartMs: 300,
      trimEndMs: 200,
    }),
    /Trim range must fit inside the source duration/,
  );
});

test('trim processing rejects an unsupported declared MIME type', async () => {
  await assert.rejects(
    trimSourceFile({
      source: createWavFixture(500),
      mimeType: 'application/octet-stream',
      trimStartMs: 100,
      trimEndMs: 300,
    }),
    /Sound must be an MP3, WAV, or OGG file/,
  );
});

test('trim processing rejects unsupported source bytes forged with an allowed MIME label', async () => {
  await assert.rejects(
    trimSourceFile({
      source: Buffer.from('fLaC'),
      mimeType: 'audio/wav',
      trimStartMs: 100,
      trimEndMs: 300,
    }),
    /Sound must be an MP3, WAV, or OGG file/,
  );
});

test('audio detection rejects an ID3 tag without an MPEG frame after its declared payload', () => {
  const id3Only = Buffer.from([
    0x49, 0x44, 0x33,
    0x04, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x04,
    0xde, 0xad, 0xbe, 0xef,
  ]);

  assert.equal(detectSupportedAudioMimeType(id3Only), null);
});

test('audio detection rejects a plausible MPEG header when its frame is truncated', () => {
  const truncatedFrame = Buffer.alloc(100);
  truncatedFrame.set([0xff, 0xfb, 0x90, 0x00]);

  assert.equal(detectSupportedAudioMimeType(truncatedFrame), null);
});

test('audio detection rejects a single complete zero-filled MPEG frame', () => {
  assert.equal(detectSupportedAudioMimeType(createMpeg1Layer3Frame()), null);
});

test('audio detection keeps complete MP3 frames and WAV/OGG signatures supported', () => {
  assert.equal(detectSupportedAudioMimeType(createRawMp3()), 'audio/mpeg');
  assert.equal(detectSupportedAudioMimeType(createId3TaggedMp3()), 'audio/mpeg');
  assert.equal(detectSupportedAudioMimeType(createWavFixture(100)), 'audio/wav');
  assert.equal(detectSupportedAudioMimeType(Buffer.from('OggS\x00\x02')), 'audio/ogg');
});

test('normalized PCM output estimate exceeds the 10 MiB cap before processing', () => {
  assert.ok(estimateNormalizedWavBytes(60_000) > 10 * 1024 * 1024);
});

test('trim processing returns a playable buffer for a WAV source', async () => {
  const result = await trimSourceFile({
    source: createWavFixture(500),
    mimeType: 'audio/wav',
    trimStartMs: 100,
    trimEndMs: 300,
  });

  assert.ok(result.buffer.length > 44);
  assert.ok(result.durationSec > 0);
  assert.ok(result.durationSec <= 0.25);
});
