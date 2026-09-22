import test from 'node:test';
import assert from 'node:assert/strict';
import { translate, translateToJapanese } from '../src/features/speech/translate';

test('translation joins all segments and sends auto-detected source to Japanese', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('q'), 'สวัสดี & hello');
    assert.equal(parsed.searchParams.get('sl'), 'auto');
    assert.equal(parsed.searchParams.get('tl'), 'ja');
    assert.ok(init.signal);
    return Response.json([[['こんにちは', ''], ['。', '']]]);
  });
  assert.equal(await translateToJapanese(' สวัสดี & hello '), 'こんにちは。');
});

test('translation rejects empty input without a network request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected call'); });
  await assert.rejects(translate('  '), /Type a message/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('malformed, empty and failed translations never become spoken text', async (t) => {
  for (const data of [null, {}, [], [[]], [[[123, '']]], [[['', '']]]]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(data));
    await assert.rejects(translateToJapanese('hello'), /Could not translate to Japanese/);
    mock.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  await assert.rejects(translateToJapanese('hello'), /Please try again/);
});
