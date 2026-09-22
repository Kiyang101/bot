import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VoiceBasedChannel } from 'discord.js';
import { EntranceService, type EntranceDependencies } from '../src/features/entrance/service';
import { claimAudio, claimSpeech, releaseAudio, type AudioOwner } from '../src/audio/oneShotOwnership';

function setup() {
  let now = 1000;
  let channelId: string | null = 'voice';
  let played = 0;
  const dependencies: EntranceDependencies = {
    now: () => now,
    readyChannel: () => channelId,
    busy: () => false,
    preference: async () => ({ enabled: true, soundId: 'sound' }),
    sound: async () => ({ url: 'https://example.test/audio', durationSec: 1, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 }),
    play: async (_channel, _sound, _valid, _deadline, owner) => { played += 1; releaseAudio('guild', owner); },
    cancel: () => {},
  };
  const event = {
    guildId: 'guild', userId: 'user', oldChannelId: null,
    channel: { id: 'voice' } as VoiceBasedChannel,
    isBot: false, isStage: false, currentChannelId: () => channelId,
  };
  return { dependencies, event, get played() { return played; }, advance: (ms: number) => { now += ms; }, moveBot: () => { channelId = 'other'; } };
}

test('eligible join plays once and cooldown uses fake time', async () => {
  const f = setup();
  const service = new EntranceService(f.dependencies);
  assert.equal(await service.handle(f.event), 'played');
  assert.equal(await service.handle(f.event), 'cooldown');
  f.advance(60_000);
  assert.equal(await service.handle(f.event), 'played');
  assert.equal(f.played, 2);
});

test('same-channel updates, bots and absent connection are ineligible', async () => {
  const f = setup();
  const service = new EntranceService(f.dependencies);
  assert.equal(await service.handle({ ...f.event, oldChannelId: 'voice' }), 'ineligible');
  assert.equal(await service.handle({ ...f.event, isBot: true }), 'ineligible');
  f.moveBot();
  assert.equal(await service.handle({ ...f.event, currentChannelId: () => 'voice' }), 'channel_changed');
  assert.equal(f.played, 0);
});

test('parallel events reserve before async preference reads', async () => {
  const f = setup();
  let resolve!: (value: { enabled: boolean; soundId: string }) => void;
  f.dependencies.preference = () => new Promise((done) => { resolve = done; });
  const service = new EntranceService(f.dependencies);
  const first = service.handle(f.event);
  assert.equal(await service.handle(f.event), 'cooldown');
  resolve({ enabled: true, soundId: 'sound' });
  assert.equal(await first, 'played');
  assert.equal(f.played, 1);
});

test('member departure during lookup skips playback', async () => {
  const f = setup();
  let current: string | null = 'voice';
  f.event.currentChannelId = () => current;
  f.dependencies.preference = async () => { current = null; return { enabled: true, soundId: 'sound' }; };
  assert.equal(await new EntranceService(f.dependencies).handle(f.event), 'channel_changed');
  assert.equal(f.played, 0);
});

test('admitted preparation reserves audio and speech preempts it', async () => {
  const f = setup();
  let resolve!: (value: { enabled: boolean; soundId: string }) => void;
  f.dependencies.preference = () => new Promise((done) => { resolve = done; });
  const service = new EntranceService(f.dependencies);
  const request = service.handle(f.event);
  const manual: AudioOwner = { kind: 'sound' };
  assert.equal(claimAudio('guild', manual), false);
  const speech: AudioOwner = { kind: 'speech' };
  claimSpeech('guild', speech);
  resolve({ enabled: true, soundId: 'sound' });
  assert.equal(await request, 'channel_changed');
  assert.equal(f.played, 0);
  releaseAudio('guild', speech);
});

test('saved speech uses the same entrance playback path without resolving a sound', async () => {
  const f = setup();
  f.dependencies.preference = async () => ({ enabled: true, mode: 'speech', soundId: null, speechPath: 'private', speechDurationSec: 1 });
  f.dependencies.sound = async () => { throw new Error('sound resolver should not run'); };
  let resolved = false;
  f.dependencies.speech = async (guildId, userId, preference) => {
    assert.equal(guildId, 'guild');
    assert.equal(userId, 'user');
    assert.equal(preference.speechPath, 'private');
    resolved = true;
    return { url: 'https://example.test/speech', durationSec: 1, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  };
  assert.equal(await new EntranceService(f.dependencies).handle(f.event), 'played');
  assert.equal(resolved, true);
  assert.equal(f.played, 1);
});
