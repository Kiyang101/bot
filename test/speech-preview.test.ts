import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePreview, handleSpeak } from '../src/control/handlers/voice';
import { voiceSession } from '../src/features/speech/session';

test('Speak follows the dashboard user into their current voice room', async (t) => {
  const room = { id: 'room', guild: { id: 'guild' }, isVoiceBased: () => true };
  const client = {
    guilds: { cache: new Map([['guild', {
      voiceStates: { cache: new Map([['user', { channel: room }]]) },
      members: { cache: new Map() },
    }]]) },
    channels: { fetch: async () => { throw new Error('should not fetch an explicit room'); } },
  } as unknown as Parameters<typeof handleSpeak>[0];
  const spoken = t.mock.method(voiceSession, 'speak', async () => {});
  await handleSpeak(client, { guildId: 'guild', userId: 'user', text: '日本語', provider: 'voicevox', translate: false });
  assert.equal(spoken.mock.calls[0].arguments[0], room);
  assert.equal(spoken.mock.calls[0].arguments[1], '日本語');
});

test('Speak gives a clear error when automatic channel is unavailable', async () => {
  const client = { guilds: { cache: new Map([['guild', { voiceStates: { cache: new Map() }, members: { cache: new Map() } }]]) } } as unknown as Parameters<typeof handleSpeak>[0];
  await assert.rejects(handleSpeak(client, { guildId: 'guild', userId: 'user', text: 'Hello' }), /You must be in a voice channel/);
});

test('VOICEVOX preview translates by default and honors raw reading', async (t) => {
  let translations = 0;
  const texts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    if (url.hostname === 'translate.googleapis.com') {
      translations++;
      return Response.json([[['こんにちは', 'hello']]]);
    }
    if (url.pathname === '/audio_query') {
      texts.push(url.searchParams.get('text')!);
      return Response.json({ accent_phrases: [{}] });
    }
    assert.equal(url.pathname, '/synthesis');
    return new Response(new Uint8Array([1, 2, 3]));
  });
  assert.equal((await handlePreview({ text: 'hello', provider: 'voicevox' })).spoken, 'こんにちは');
  assert.equal((await handlePreview({ text: '日本語', provider: 'voicevox', translate: false })).spoken, '日本語');
  assert.equal(translations, 1);
  assert.deepEqual(texts, ['こんにちは', '日本語']);
});

test('Google preview ignores stale translation flag', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    assert.equal(new URL(input).pathname, '/translate_tts');
    return new Response(new Uint8Array([1]));
  });
  assert.equal((await handlePreview({ text: 'สวัสดี', provider: 'google', voice: 'th', translate: true })).spoken, 'สวัสดี');
});

test('failed translation stops before synthesis', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async (input: string) => {
    assert.equal(new URL(input).hostname, 'translate.googleapis.com');
    return new Response('', { status: 503 });
  });
  await assert.rejects(handlePreview({ text: 'hello', provider: 'voicevox' }), /Could not translate/);
  assert.equal(mock.mock.callCount(), 1);
});

test('server default VOICEVOX also translates when reading option is omitted', async (t) => {
  const previous = process.env.AI_TTS_PROVIDER;
  process.env.AI_TTS_PROVIDER = 'voicevox';
  t.after(() => {
    if (previous === undefined) delete process.env.AI_TTS_PROVIDER;
    else process.env.AI_TTS_PROVIDER = previous;
  });
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    if (url.hostname === 'translate.googleapis.com') return Response.json([[['こんにちは', 'hello']]]);
    if (url.pathname === '/audio_query') {
      assert.equal(url.searchParams.get('text'), 'こんにちは');
      return Response.json({ accent_phrases: [{}] });
    }
    return new Response(new Uint8Array([1]));
  });
  assert.equal((await handlePreview({ text: 'hello', provider: 'default' })).spoken, 'こんにちは');
});
