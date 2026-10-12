import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits, type Guild, type Message } from 'discord.js';
import { ChatService, CHAT_ERRORS, type ChatRequest } from '../src/features/chat/service';
import { completeChat } from '../src/features/chat/ollama';
import { finalAnswer, limitText, spokenAnswer, replyChunks } from '../src/features/chat/text';
import { chatSpeaker } from '../src/features/chat/discord';
import { createLocalTTS } from '../src/features/speech/providers/local';
import { getSelectedProviders, resolveTtsVoice, ttsVoiceChoices } from '../src/features/speech/providers/config';
import { pcmToWav } from '../src/features/speech/audio';
import { voiceSession } from '../src/features/speech/session';
import { createClient } from '../src/app/client';
import messageCreate from '../src/events/messageCreate';
import { chatService } from '../src/features/chat/service';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { guildId: 'guild', channelId: 'channel', userId: 'user', text: 'สวัสดี', reply: async () => {}, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('history isolates guild, channel and user; keeps ten pairs; expires after 30 minutes', async () => {
  const inputs: { role: string; content: string }[][] = [];
  let now = 0;
  const service = new ChatService(async (messages) => {
    inputs.push([...messages]);
    return 'คำตอบ';
  }, () => now);
  for (let i = 0; i < 12; i++) await service.submit(request({ text: `ข้อความ ${i}` }));
  assert.equal(inputs[11].length, 21);
  assert.equal(inputs[11][0].content, 'ข้อความ 1');
  for (const override of [{ guildId: 'other' }, { channelId: 'other' }, { userId: 'other' }]) {
    await service.submit(request(override));
    assert.equal(inputs.at(-1)!.length, 1);
  }
  now = 30 * 60_000;
  await service.submit(request());
  assert.equal(inputs.at(-1)!.length, 1);
  service.reset(request());
  await service.submit(request());
  assert.equal(inputs.at(-1)!.length, 1);
});

test('reset during generation does not restore the old conversation', async () => {
  const answer = deferred<string>();
  const inputs: number[] = [];
  const service = new ChatService(async (messages) => { inputs.push(messages.length); return answer.promise; });
  const running = service.submit(request());
  service.reset(request());
  answer.resolve('hello');
  await running;
  await service.submit(request());
  assert.deepEqual(inputs, [1, 1]);
});

test('one active chat plus five waiting; queue recovers and rejects invalid input', async () => {
  const gate = deferred<string>();
  let calls = 0;
  const service = new ChatService(async () => { calls++; return gate.promise; });
  const jobs = Array.from({ length: 6 }, () => service.submit(request()));
  assert.equal(calls, 1);
  await assert.rejects(service.submit(request()), { message: CHAT_ERRORS.full });
  await assert.rejects(service.submit(request({ text: 'x'.repeat(2001) })), { message: CHAT_ERRORS.input });
  await assert.rejects(service.submit(request({ text: ' ' })), { message: CHAT_ERRORS.input });
  gate.resolve('hello');
  await Promise.all(jobs);
  assert.equal(calls, 6);
  await service.submit(request());
  assert.equal(calls, 7);
});

test('text precedes speech; speech failure retains text and conversation; next job still runs', async () => {
  const events: string[] = [];
  const lengths: number[] = [];
  const service = new ChatService(async (messages) => { lengths.push(messages.length); return '**สวัสดี** Hello'; });
  await service.submit(request({
    reply: async (text) => { events.push(text); },
    speak: async (text) => { events.push(`speak:${text}`); throw new Error('TTS down'); },
  }));
  assert.deepEqual(events, ['**สวัสดี** Hello', 'speak:สวัสดี Hello', CHAT_ERRORS.speech]);
  await service.submit(request());
  assert.deepEqual(lengths, [1, 3]);
});

test('Ollama failure and timeout produce Thai errors, no speech, and no failed history', async () => {
  let fail = true;
  const replies: string[] = [];
  const service = new ChatService(async (messages) => {
    assert.equal(messages.length, 1);
    if (fail) throw new DOMException('Timed out', 'TimeoutError');
    return 'hello';
  });
  await service.submit(request({ reply: async (text) => { replies.push(text); }, speak: async () => assert.fail('no speech') }));
  assert.deepEqual(replies, [CHAT_ERRORS.ollama]);
  fail = false;
  await service.submit(request());
});

test('Ollama posts non-streaming Qwen chat with thinking disabled and only returns final content', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(new URL(url).pathname, '/api/chat');
    const body = JSON.parse(options.body as string);
    assert.equal(body.think, false);
    assert.equal(body.stream, false);
    assert.equal(body.model, 'qwen3:4b');
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(body.messages[1], { role: 'user', content: 'Hello\n/no_think' });
    assert.ok(options.signal);
    return Response.json({ message: { content: '<think>private</think>Hi', thinking: 'also private' } });
  });
  assert.equal(await completeChat([{ role: 'user', content: 'Hello' }]), 'Hi');
});

test('Ollama rejects HTTP failures, malformed replies and empty final answers', async (t) => {
  for (const response of [new Response('', { status: 503 }), Response.json({}),
    Response.json({ message: { content: '<think>only reasoning</think>' } })]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(completeChat([]));
    mocked.mock.restore();
  }
});

test('spoken text cleans Markdown and reasoning; truncation respects sentences and Unicode', () => {
  assert.equal(spokenAnswer('<think>secret</think>## สวัสดี **Hello** [world](https://x.test)\n```js\ncode\n```'), 'สวัสดี Hello world');
  assert.equal(finalAnswer('<think>unfinished'), '');
  assert.equal(finalAnswer('prefilled private reasoning</think>สวัสดี'), 'สวัสดี');
  assert.equal(spokenAnswer('```code only```'), '');
  assert.equal(limitText('Hello. ' + 'x'.repeat(1000), 1000), 'Hello.');
  assert.equal(spokenAnswer('ก'.repeat(1200)).length, 1000);
  assert.equal(limitText('x'.repeat(999) + '😀', 1000), 'x'.repeat(999));
  const long = 'ก'.repeat(1999) + '😀' + 'ข'.repeat(1000);
  const chunks = replyChunks(long);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  assert.equal(chunks.join(''), long);
});

test('local TTS is keyless, uses local voice instead of stale cloud voice, and validates audio', async (t) => {
  const previous = { provider: process.env.AI_TTS_PROVIDER, voice: process.env.AI_TTS_VOICE, local: process.env.LOCAL_TTS_VOICE };
  process.env.AI_TTS_PROVIDER = 'local';
  process.env.AI_TTS_VOICE = 'alloy';
  delete process.env.LOCAL_TTS_VOICE;
  t.after(() => {
    for (const [key, value] of Object.entries({ AI_TTS_PROVIDER: previous.provider, AI_TTS_VOICE: previous.voice, LOCAL_TTS_VOICE: previous.local })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  assert.equal(getSelectedProviders().tts, 'local');
  assert.equal(resolveTtsVoice('local'), 'f_young_clear');
  assert.ok(ttsVoiceChoices('local').length);
  const wav = pcmToWav(Buffer.from([0, 0, 1, 0]), 24000, 1, 16);
  const mocked = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'http://127.0.0.1:8788/synthesize');
    assert.deepEqual(JSON.parse(options.body as string), { text: 'สวัสดี', voice: 'm_young_clear' });
    return new Response(wav);
  });
  assert.deepEqual(await createLocalTTS().synthesize('สวัสดี', 'm_young_clear'), wav);
  mocked.mock.restore();
  for (const response of [new Response('', { status: 503 }), new Response(''), new Response('invalid audio')]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(createLocalTTS().synthesize('hi'));
    mock.mock.restore();
  }
});

function guildFixture() {
  const room = { id: 'room', guild: { id: 'voice-test' } };
  const other = { id: 'other', guild: { id: 'voice-test' } };
  const states = new Map<string, { channel: typeof room }>([['user', { channel: room }]]);
  const me = { voice: { channelId: null as string | null } };
  const guild = { id: 'voice-test', voiceStates: { cache: states }, members: { me } } as unknown as Guild;
  return { room, other, states, me, guild };
}

test('chat follows live voice state and never moves the bot from another room', async (t) => {
  const { room, other, states, me, guild } = guildFixture();
  const replies: string[] = [];
  const speak = t.mock.method(voiceSession, 'speak', async (channel, text, voice, provider, guard) => {
    assert.equal(channel, room);
    assert.equal(provider?.name, 'local');
    states.set('user', { channel: other });
    assert.equal(guard!(), other);
    me.voice.channelId = 'room';
    assert.throws(guard!, /ห้องเสียงอื่น/);
    states.delete('user');
    assert.throws(guard!, /ออกจากห้องเสียง/);
  });
  await chatSpeaker(guild, 'user', async (text) => { replies.push(text); })('hello');
  assert.equal(speak.mock.callCount(), 1);
  states.set('user', { channel: other });
  await chatSpeaker(guild, 'user', async (text) => { replies.push(text); })('hello');
  assert.match(replies[0], /ห้องเสียงอื่น/);
  assert.equal(speak.mock.callCount(), 1);
  states.delete('user');
  await chatSpeaker(guild, 'user', async () => assert.fail('text-only is normal'))('hello');
});

test('mention adapter ignores bots, webhooks, DMs and messages without an explicit mention', async (t) => {
  const submitted = t.mock.method(chatService, 'submit', async () => {});
  const base = { guild: {}, author: { id: 'user', bot: false }, webhookId: null,
    client: { user: { id: '123' } }, channelId: 'channel', content: '<@123> สวัสดี' };
  for (const overrides of [{ guild: null }, { author: { bot: true } }, { webhookId: 'hook' }, { content: 'hello' }]) {
    await messageCreate.execute({ ...base, ...overrides } as unknown as Message);
  }
  assert.equal(submitted.mock.callCount(), 0);
  await messageCreate.execute(base as unknown as Message);
  assert.equal(submitted.mock.calls[0].arguments[0].text, 'สวัสดี');
});

test('client discovers chat commands and subscribes to guild message intents', async () => {
  const client = createClient();
  try {
    assert.ok(client.commands.has('chat'));
    assert.ok(client.commands.has('chat-reset'));
    assert.ok(client.options.intents.has(GatewayIntentBits.GuildMessages));
    assert.ok(client.options.intents.has(GatewayIntentBits.MessageContent));
  } finally { await client.destroy(); }
});
