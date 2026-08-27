import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { AudioMixer } from '../src/lib/voice/audioMixer';
import { createAudioStream } from '../src/lib/music/ytdlp';
import { musicManager, SoundboardBusyError } from '../src/lib/music/musicSession';
import {
  handleSoundboard,
  soundboardErrorResponse,
  type SoundboardBody,
  type SoundboardSessions,
} from '../src/control/server';

const FRAME_BYTES = 48_000 / 50 * 2 * 2;
function pcmFrame(sample: number): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) frame.writeInt16LE(sample, offset);
  return frame;
}
async function readFrame(mixer: AudioMixer): Promise<Buffer> {
  const chunk = mixer.read(FRAME_BYTES) as Buffer | null;
  if (chunk) return chunk;
  return await new Promise((resolve, reject) => {
    mixer.once('data', (data: Buffer) => resolve(data));
    mixer.once('error', reject);
  });
}

test('mixes main and overlay samples with saturation', async () => {
  const mixer = new AudioMixer();
  mixer.setMain(Readable.from([pcmFrame(30_000)]));
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(10_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), true);
  const frame = await readFrame(mixer);
  assert.equal(frame.readInt16LE(0), 32_767);
});

test('rejects a second overlay while the first is active', () => {
  const mixer = new AudioMixer();
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(1_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), true);
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(2_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), false);
});

test('stopping an overlay leaves the main source active', async () => {
  const mixer = new AudioMixer();
  mixer.setMain(Readable.from([pcmFrame(4_000), pcmFrame(4_000)]));
  mixer.startOverlay(Readable.from([pcmFrame(1_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 });
  mixer.stopOverlay();
  assert.equal((await readFrame(mixer)).readInt16LE(0), 4_000);
});

test('pausing the main source still allows an overlay to play', async () => {
  const mixer = new AudioMixer();
  mixer.setMain(Readable.from([pcmFrame(4_000), pcmFrame(4_000)]));
  assert.equal(mixer.pauseMain(), true);
  mixer.startOverlay(Readable.from([pcmFrame(1_000)]), {
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
  });
  assert.equal((await readFrame(mixer)).readInt16LE(0), 1_000);
  assert.equal(mixer.resumeMain(), true);
  assert.equal((await readFrame(mixer)).readInt16LE(0), 4_000);
});

test('does not count emitted silence as main playback time', async () => {
  const mixer = new AudioMixer();
  const main = new PassThrough();
  mixer.setMain(main);
  assert.equal((await readFrame(mixer)).readInt16LE(0), 0);
  assert.equal(mixer.mainPlaybackDurationMs, 0);
  main.write(pcmFrame(2_000));
  assert.equal((await readFrame(mixer)).readInt16LE(0), 2_000);
  assert.equal(mixer.mainPlaybackDurationMs, 20);
});

test('clears a naturally completed overlay and accepts the next one', async () => {
  const mixer = new AudioMixer();
  const ended = once(mixer, 'overlayEnded');
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(1_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), true);
  assert.equal((await readFrame(mixer)).readInt16LE(0), 1_000);
  await ended;
  assert.equal(mixer.startOverlay(Readable.from([pcmFrame(2_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }), true);
});

test('buffers partial chunks independently before mixing a complete frame', async () => {
  const mixer = new AudioMixer();
  const main = new PassThrough();
  const overlay = new PassThrough();
  mixer.setMain(main);
  mixer.startOverlay(overlay, { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 });
  main.write(pcmFrame(2_000).subarray(0, FRAME_BYTES / 2));
  overlay.write(pcmFrame(3_000).subarray(0, FRAME_BYTES / 2));
  main.end(pcmFrame(2_000).subarray(FRAME_BYTES / 2));
  overlay.end(pcmFrame(3_000).subarray(FRAME_BYTES / 2));
  assert.equal((await readFrame(mixer)).readInt16LE(0), 5_000);
});

test('applies decibel gain and fade envelopes to an overlay', async () => {
  const gainMixer = new AudioMixer();
  gainMixer.startOverlay(Readable.from([pcmFrame(10_000)]), {
    gainDb: -6.020599913279624,
    fadeInMs: 0,
    fadeOutMs: 0,
  });
  assert.equal((await readFrame(gainMixer)).readInt16LE(0), 5_000);

  const fadeInMixer = new AudioMixer();
  fadeInMixer.startOverlay(Readable.from([pcmFrame(10_000), pcmFrame(10_000)]), {
    gainDb: 0,
    fadeInMs: 20,
    fadeOutMs: 0,
  });
  assert.equal((await readFrame(fadeInMixer)).readInt16LE(0), 0);
  assert.equal((await readFrame(fadeInMixer)).readInt16LE(0), 10_000);

  const fadeOutMixer = new AudioMixer();
  fadeOutMixer.startOverlay(Readable.from([pcmFrame(10_000), pcmFrame(10_000)]), {
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 20,
  });
  await readFrame(fadeOutMixer);
  const finalFrame = await readFrame(fadeOutMixer);
  assert.ok(Math.abs(finalFrame.readInt16LE(FRAME_BYTES - 2)) < 20);
});

test('reports natural main completion without treating overlay stop as main completion', async () => {
  const mixer = new AudioMixer();
  let mainEnded = 0;
  mixer.on('mainEnded', () => { mainEnded += 1; });
  const ended = once(mixer, 'mainEnded');
  mixer.setMain(Readable.from([pcmFrame(4_000)]));
  mixer.startOverlay(Readable.from([pcmFrame(1_000)]), { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 });
  mixer.stopOverlay();
  await readFrame(mixer);
  await ended;
  assert.equal(mainEnded, 1);
});

test('applies backpressure when a source buffer grows beyond the mixer reserve', () => {
  const mixer = new AudioMixer();
  const main = new PassThrough();
  mixer.setMain(main);
  main.write(Buffer.alloc(3 * 1024 * 1024));
  assert.equal(main.isPaused(), true);
});

test('clears a source that closes without emitting end', async () => {
  const mixer = new AudioMixer();
  const main = new PassThrough();
  mixer.setMain(main);
  const outcome = Promise.race([
    once(mixer, 'mainEnded').then(() => 'ended'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ]);
  main.destroy();
  assert.equal(await outcome, 'ended');
});

function clientFor(channelGuildId = 'guild-1'): Client {
  const channel = {
    id: 'voice-1',
    guild: { id: channelGuildId },
    isVoiceBased: () => true,
  } as unknown as VoiceBasedChannel;
  return {
    channels: { fetch: async () => channel },
  } as unknown as Client;
}

const playBody: SoundboardBody = {
  guildId: 'guild-1',
  channelId: 'voice-1',
  audioUrl: 'https://storage.example.test/signed/playable?token=secret',
  gainDb: -3,
  fadeInMs: 40,
  fadeOutMs: 80,
};

test('plays through the overlay boundary without changing music controls or queue', async () => {
  const queue = ['music-a', 'music-b'];
  let pauseCalls = 0;
  let stopCalls = 0;
  let received: unknown;
  const session = {
    playSound: async (channel: VoiceBasedChannel, audioUrl: string, options: unknown) => {
      received = { channelId: channel.id, audioUrl, options };
    },
    stopSound: () => {},
    pause: () => { pauseCalls += 1; },
    stop: () => { stopCalls += 1; },
  };
  const sessions: SoundboardSessions = {
    get: () => session,
    getOrCreate: () => session,
  };

  assert.deepEqual(await handleSoundboard(clientFor(), playBody, 'play', sessions), { ok: true });
  assert.deepEqual(received, {
    channelId: 'voice-1',
    audioUrl: playBody.audioUrl,
    options: { gainDb: -3, fadeInMs: 40, fadeOutMs: 80 },
  });
  assert.equal(pauseCalls, 0);
  assert.equal(stopCalls, 0);
  assert.deepEqual(queue, ['music-a', 'music-b']);
});

test('rejects loop and non-HTTP audio inputs at the control boundary', async () => {
  const sessions: SoundboardSessions = {
    get: () => null,
    getOrCreate: () => { throw new Error('must not create a session'); },
  };
  await assert.rejects(
    handleSoundboard(
      clientFor(),
      { ...playBody, loop: false } as SoundboardBody,
      'play',
      sessions,
    ),
    /loop is not supported/,
  );
  await assert.rejects(
    handleSoundboard(clientFor(), { ...playBody, audioUrl: 'file:\/\/\/tmp\/sound.wav' }, 'play', sessions),
    /audioUrl must be a server-resolved HTTP\(S\) URL/,
  );
});

test('rejects a voice channel owned by a different guild', async () => {
  const sessions: SoundboardSessions = {
    get: () => null,
    getOrCreate: () => { throw new Error('must not create a session'); },
  };
  await assert.rejects(
    handleSoundboard(clientFor('guild-2'), playBody, 'play', sessions),
    /different Discord server/,
  );
});

test('stops only the active soundboard overlay', async () => {
  let overlayStops = 0;
  let musicStops = 0;
  const session = {
    playSound: async () => {},
    stopSound: () => { overlayStops += 1; },
    stop: () => { musicStops += 1; },
  };
  const sessions: SoundboardSessions = {
    get: () => session,
    getOrCreate: () => session,
  };
  assert.deepEqual(
    await handleSoundboard(clientFor(), { guildId: 'guild-1' }, 'stop', sessions),
    { ok: true },
  );
  assert.equal(overlayStops, 1);
  assert.equal(musicStops, 0);
});

test('maps an occupied overlay to the typed busy response and keeps unexpected errors internal', () => {
  assert.deepEqual(soundboardErrorResponse(new SoundboardBusyError()), {
    status: 409,
    payload: { error: 'soundboard_busy' },
  });
  assert.deepEqual(soundboardErrorResponse(new Error('decode failed')), {
    status: 500,
    payload: { error: 'decode failed' },
  });
});

test('reserves the overlay slot while the first sound is still connecting', async () => {
  const guildId = 'guild-concurrent-sound';
  const session = musicManager.getOrCreate(guildId);
  const readyConnection = new EventEmitter() as EventEmitter & VoiceConnection;
  Object.defineProperty(readyConnection, 'state', {
    configurable: true,
    value: { status: VoiceConnectionStatus.Connecting },
  });
  Object.defineProperty(session, 'ensureConnection', {
    value: () => readyConnection,
  });
  const channel = {
    id: 'voice-concurrent-sound',
    guild: { id: guildId },
  } as VoiceBasedChannel;

  const firstResult = session
    .playSound(channel, 'https://storage.example.test/first.wav', {
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  const secondResult = session.playSound(
    channel,
    'https://storage.example.test/second.wav',
    { gainDb: 0, fadeInMs: 0, fadeOutMs: 0 },
  );
  session.stopSound();
  Object.defineProperty(readyConnection, 'state', {
    configurable: true,
    value: { status: VoiceConnectionStatus.Ready },
  });
  readyConnection.emit(VoiceConnectionStatus.Ready);

  try {
    await assert.rejects(secondResult, SoundboardBusyError);
    assert.match(String(await firstResult), /stopped before it started/);
  } finally {
    session.stop();
  }
});

test('reports a decode failure before a direct PCM stream is accepted', async () => {
  const audio = createAudioStream({
    url: '/private/tmp/soundboard-audio-that-does-not-exist.wav',
    output: 'pcm',
  });
  try {
    await assert.rejects(audio.ready, /Could not decode audio \(url\)/);
  } finally {
    audio.destroy();
  }
});
