import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const VIEW_CHANNEL = 1_024;
const CONNECT = 1_048_576;
const EVERYONE_PERMISSIONS = String(VIEW_CHANNEL + CONNECT);

describe('canMemberUseVoiceChannel', () => {
  const originalToken = process.env.DISCORD_TOKEN;

  beforeEach(() => {
    process.env.DISCORD_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalToken;
    vi.restoreAllMocks();
  });

  test('rejects a member denied VIEW_CHANNEL or CONNECT on the selected voice channel', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/channels/voice-1')) {
        return new Response(JSON.stringify({
          id: 'voice-1',
          guild_id: 'guild-1',
          type: 2,
          permission_overwrites: [{ id: 'member-1', type: 1, allow: '0', deny: String(CONNECT) }],
        }), { status: 200 });
      }
      if (url.endsWith('/guilds/guild-1/members/member-1')) {
        return new Response(JSON.stringify({ user: { id: 'member-1' }, roles: [] }), { status: 200 });
      }
      if (url.endsWith('/guilds/guild-1/roles')) {
        return new Response(JSON.stringify([{ id: 'guild-1', permissions: EVERYONE_PERMISSIONS }]), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const { canMemberUseVoiceChannel } = await import('./discord');

    expect(await canMemberUseVoiceChannel('guild-1', 'voice-1', 'member-1')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('accepts a member with effective VIEW_CHANNEL and CONNECT permissions', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/channels/voice-1')) {
        return new Response(JSON.stringify({ id: 'voice-1', guild_id: 'guild-1', type: 2 }), { status: 200 });
      }
      if (url.endsWith('/guilds/guild-1/members/member-1')) {
        return new Response(JSON.stringify({ user: { id: 'member-1' }, roles: ['role-1'] }), { status: 200 });
      }
      if (url.endsWith('/guilds/guild-1/roles')) {
        return new Response(JSON.stringify([
          { id: 'guild-1', permissions: '0' },
          { id: 'role-1', permissions: EVERYONE_PERMISSIONS },
        ]), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const { canMemberUseVoiceChannel } = await import('./discord');

    expect(await canMemberUseVoiceChannel('guild-1', 'voice-1', 'member-1')).toBe(true);
  });
});
