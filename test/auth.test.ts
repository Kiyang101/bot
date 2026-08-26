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

test('does not expose the Supabase email when Discord username data is unavailable', () => {
  const oldAdmin = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = 'discord-user';
  try {
    const user = sessionUserFromSupabaseUser({
      id: 'supabase-user',
      email: 'private@example.com',
      identities: [{ id: 'discord-user', provider: 'discord' }],
    });
    assert.equal(user?.username, 'Discord user');
  } finally {
    process.env.ADMIN_USER_IDS = oldAdmin;
  }
});

test('uses the Discord username mirrored in Supabase user metadata', () => {
  const oldAdmin = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = 'discord-user';
  try {
    const user = sessionUserFromSupabaseUser({
      id: 'supabase-user',
      email: 'private@example.com',
      user_metadata: { username: 'discord-handle' },
      identities: [{ id: 'discord-user', provider: 'discord' }],
    });
    assert.equal(user?.username, 'discord-handle');
  } finally {
    process.env.ADMIN_USER_IDS = oldAdmin;
  }
});

test('uses the Discord display name stored in Supabase user metadata', () => {
  const oldAdmin = process.env.ADMIN_USER_IDS;
  process.env.ADMIN_USER_IDS = 'discord-user';
  try {
    const user = sessionUserFromSupabaseUser({
      id: 'supabase-user',
      user_metadata: { full_name: 'kiyang#0' },
      identities: [{ id: 'discord-user', provider: 'discord' }],
    });
    assert.equal(user?.username, 'kiyang#0');
  } finally {
    process.env.ADMIN_USER_IDS = oldAdmin;
  }
});
