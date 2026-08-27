import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import type { Track } from '../src/lib/music/types';
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

function wavBuffer(sample: number, frames = 48_000): Buffer {
  const dataSize = frames * 2 * 2;
  const wav = Buffer.concat([wavHeader(dataSize), Buffer.alloc(dataSize)]);
  for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(sample, offset);
  return wav;
}

function wavHeader(dataSize: number): Buffer {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(48_000 * 2 * 2, 28);
  wav.writeUInt16LE(2 * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

async function startWavServer(
  routes: Record<
    string,
    (res: http.ServerResponse, req: http.IncomingMessage) => void | Promise<void>
  >,
): Promise<{ url(path: string): string; close(): Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const handler = routes[req.url ?? ''];
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }
    void Promise.resolve(handler(res, req)).catch((error) => {
      res.destroy(error);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
    }),
  };
}

function writeAudio(res: http.ServerResponse, audio: Buffer, rangeHeader?: string): void {
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? '');
  const start = match ? Number(match[1]) : 0;
  const requestedEnd = match?.[2] ? Number(match[2]) : audio.length - 1;
  const end = Math.min(requestedEnd, audio.length - 1);
  const body = audio.subarray(start, end + 1);
  const headers: http.OutgoingHttpHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Length': body.length,
    'Content-Type': 'audio/wav',
  };
  if (match) headers['Content-Range'] = `bytes ${start}-${end}/${audio.length}`;
  res.writeHead(match ? 206 : 200, headers);
  res.end(body);
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

const track: Track = {
  title: 'Test Track',
  url: 'https://youtube.example.test/watch?v=test',
  durationSec: 60,
  thumbnail: null,
  uploader: null,
  requestedById: 'user-1',
  requestedByTag: 'Tester',
};

test('ignores stale music streams that become ready after a newer stream is active', async () => {
  const guildId = 'guild-stale-stream';
  const session = musicManager.getOrCreate(guildId);
  let releaseSlow!: () => void;
  let markSlowRequested!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const slowRequested = new Promise<void>((resolve) => { markSlowRequested = resolve; });
  const server = await startWavServer({
    '/slow.wav': async (res, req) => {
      markSlowRequested();
      await slowGate;
      writeAudio(res, wavBuffer(1_111), req.headers.range);
    },
    '/fast.wav': (res, req) => writeAudio(res, wavBuffer(2_222), req.headers.range),
  });

  try {
    const unsafeSession = session as unknown as {
      current: Track | null;
      currentUrl: string | null;
      currentStream: { destroy(): void } | null;
      startStream(track: Track, seekSec: number): Promise<boolean | void>;
    };
    unsafeSession.current = track;
    unsafeSession.currentUrl = server.url('/slow.wav');
    const staleStart = unsafeSession.startStream(track, 0.001);
    await slowRequested;

    unsafeSession.currentUrl = server.url('/fast.wav');
    await unsafeSession.startStream(track, 0.002);
    const fastStream = unsafeSession.currentStream;
    assert.ok(fastStream);
    let fastDestroyCalls = 0;
    const originalFastDestroy = fastStream.destroy.bind(fastStream);
    fastStream.destroy = () => {
      fastDestroyCalls += 1;
      originalFastDestroy();
    };

    releaseSlow();
    await staleStart;

    assert.strictEqual(unsafeSession.currentStream, fastStream);
    assert.equal(fastDestroyCalls, 0);
  } finally {
    session.stop();
    releaseSlow();
    await server.close();
  }
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

function readyConnection(): VoiceConnection {
  return {
    state: { status: VoiceConnectionStatus.Ready },
    subscribe: () => undefined,
  } as unknown as VoiceConnection;
}

const playBody: SoundboardBody = {
  guildId: 'guild-1',
  channelId: 'voice-1',
  audioUrl: 'https://storage.example.test/signed/playable?token=secret',
  gainDb: -3,
  fadeInMs: 40,
  fadeOutMs: 80,
};

test('MusicSession soundboard play and stop preserve active music state', async () => {
  const guildId = 'guild-preserve-music';
  const session = musicManager.getOrCreate(guildId);
  const main = new PassThrough();
  const server = await startWavServer({
    '/overlay.wav': (res) => writeAudio(res, wavBuffer(1_000)),
  });

  try {
    const unsafeSession = session as unknown as {
      current: Track | null;
      queue: Track[];
      mixer: AudioMixer;
      player: { pause(): boolean; stop(force?: boolean): boolean };
      ensureConnection(channel: VoiceBasedChannel): VoiceConnection;
    };
    const nextTrack = { ...track, title: 'Queued Track', url: 'https://youtube.example.test/next' };
    unsafeSession.current = track;
    unsafeSession.queue = [nextTrack];
    unsafeSession.mixer.setMain(main);
    main.write(pcmFrame(4_000));

    let pauseCalls = 0;
    let stopCalls = 0;
    const originalPause = unsafeSession.player.pause.bind(unsafeSession.player);
    const originalStop = unsafeSession.player.stop.bind(unsafeSession.player);
    unsafeSession.player.pause = () => {
      pauseCalls += 1;
      return originalPause();
    };
    unsafeSession.player.stop = (force?: boolean) => {
      stopCalls += 1;
      return originalStop(force);
    };
    unsafeSession.ensureConnection = () => readyConnection();
    const channel = {
      id: 'voice-1',
      guild: { id: guildId },
    } as VoiceBasedChannel;

    await session.playSound(channel, server.url('/overlay.wav'), {
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
    });
    session.stopSound();

    assert.equal(pauseCalls, 0);
    assert.equal(stopCalls, 0);
    assert.deepEqual(session.getState().queue, [nextTrack]);
    assert.strictEqual(session.getState().current, track);
    assert.equal(session.pause(), true);
  } finally {
    session.stop();
    await server.close();
  }
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

test('requires a same-guild voice channel before stopping the active soundboard overlay', async () => {
  let overlayStops = 0;
  let musicStops = 0;
  let getCalls = 0;
  const session = {
    playSound: async () => {},
    stopSound: () => { overlayStops += 1; },
    stop: () => { musicStops += 1; },
  };
  const sessions: SoundboardSessions = {
    get: () => {
      getCalls += 1;
      return session;
    },
    getOrCreate: () => session,
  };
  await assert.rejects(
    handleSoundboard(clientFor(), { guildId: 'guild-1' }, 'stop', sessions),
    /channelId is required/,
  );
  await assert.rejects(
    handleSoundboard(clientFor('guild-2'), { guildId: 'guild-1', channelId: 'voice-1' }, 'stop', sessions),
    /different Discord server/,
  );
  assert.deepEqual(
    await handleSoundboard(clientFor(), { guildId: 'guild-1', channelId: 'voice-1' }, 'stop', sessions),
    { ok: true },
  );
  assert.equal(overlayStops, 1);
  assert.equal(musicStops, 0);
  assert.equal(getCalls, 1);
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
