import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPlayer, NoSubscriberBehavior, VoiceConnectionStatus } from '@discordjs/voice';
import { SpeakSession } from '../src/features/speech/session';
import { registerDuckable, unregisterDuckable } from '../src/audio/ducking';
import { pcmToWav } from '../src/features/speech/audio';

test('speech queue checks live voice after synthesis and resumes music on skip, empty audio and success', async (t) => {
  const room = { id: 'room', guild: { id: 'chat-playback' } } as any;
  const session = new SpeakSession();
  const events: string[] = [];
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const connection = {
    state: { status: VoiceConnectionStatus.Ready },
    joinConfig: { channelId: room.id },
    subscribe: () => { events.push('subscribe'); },
  };
  (session as any).player = player;
  t.mock.method(session as any, 'ensureConnection', () => connection);
  registerDuckable(room.guild.id, {
    pause: () => { events.push('pause'); },
    resume: () => { events.push('resume'); },
  });
  t.after(() => { player.stop(true); unregisterDuckable(room.guild.id); });
  let present = true;
  const guard = () => {
    if (!present) throw new Error('user left');
    return room;
  };
  await assert.rejects(session.speak(room, 'hello', undefined, {
    name: 'fake',
    synthesize: async () => { present = false; return pcmToWav(Buffer.alloc(480), 24000, 1); },
  }, guard), /user left/);
  assert.deepEqual(events, ['pause', 'resume']);
  present = true;
  events.length = 0;
  await assert.rejects(session.speak(room, 'hello', undefined, {
    name: 'fake', synthesize: async () => Buffer.alloc(0),
  }, guard), /No audio/);
  assert.deepEqual(events, ['pause', 'resume']);
  events.length = 0;
  await session.speak(room, 'hello', undefined, {
    name: 'fake', synthesize: async () => pcmToWav(Buffer.alloc(2400), 24000, 1),
  }, guard);
  assert.deepEqual(events, ['pause', 'subscribe', 'resume']);
});
