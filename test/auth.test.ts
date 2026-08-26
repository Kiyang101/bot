import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoleForDiscordId, sessionUserFromSupabaseUser } from '../dashboard/lib/auth';

test('admin allowlist takes precedence over member allowlist', () => {
  const oldAdmin = process.env.ADMIN_USER_IDS;
  const oldMember = process.env.MEMBER_USER_IDS;
  process.env.ADMIN_USER_IDS = 'discord-admin';
  process.env.MEMBER_USER_IDS = 'discord-admin,discord-member';
  try {
    assert.equal(resolveRoleForDiscordId('discord-admin'), 'admin');
    assert.equal(resolveRoleForDiscordId('discord-member'), 'member');
    assert.equal(resolveRoleForDiscordId('unknown'), null);
  } finally {
    process.env.ADMIN_USER_IDS = oldAdmin;
    process.env.MEMBER_USER_IDS = oldMember;
  }
});

test('resolves the Discord provider user id from Supabase identity id', () => {
  const oldAdmin = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = 'discord-admin';
  try {
    const user = sessionUserFromSupabaseUser({
      id: 'supabase-user',
      identities: [{ id: 'discord-admin', provider: 'discord' }],
    });
    assert.equal(user?.id, 'discord-admin');
    assert.equal(user?.role, 'admin');
  } finally {
    process.env.ADMIN_USER_IDS = oldAdmin;
  }
});
