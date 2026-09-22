import { beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.DISCORD_TOKEN = 'test-token';
  vi.restoreAllMocks();
});

test('concurrent server lists share one Discord request', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
    { id: 'guild-1', name: 'Studio', icon: null },
  ]), { status: 200 }));
  const { listGuilds } = await import('./discord');
  const [first, second] = await Promise.all([listGuilds(), listGuilds()]);
  expect(first).toEqual(second);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await listGuilds();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('server list retries a short Discord rate limit', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 0 }), { status: 429 }))
    .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'guild-1', name: 'Studio', icon: null }]), { status: 200 }));
  const { listGuilds } = await import('./discord');
  expect(await listGuilds()).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
