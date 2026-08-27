import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DASHBOARD_ROLE,
  requestOrigin,
  sessionUserFromSupabaseUser,
} from '../dashboard/lib/auth';

test('newly authenticated dashboard users default to member', () => {
  assert.equal(DEFAULT_DASHBOARD_ROLE, 'member');
});

test('uses the role stored for the authenticated Supabase user', () => {
  const user = sessionUserFromSupabaseUser(
    {
      id: 'supabase-user',
      identities: [{ id: 'discord-admin', provider: 'discord' }],
    },
    'admin',
  );
  assert.equal(user?.id, 'discord-admin');
  assert.equal(user?.role, 'admin');
});

test('denies an authenticated user when no database role is available', () => {
  const user = sessionUserFromSupabaseUser(
    {
      id: 'supabase-user',
      identities: [{ id: 'discord-user', provider: 'discord' }],
    },
    null,
  );
  assert.equal(user, null);
});

test('does not expose the Supabase email when Discord username data is unavailable', () => {
  const user = sessionUserFromSupabaseUser(
    {
      id: 'supabase-user',
      email: 'private@example.com',
      identities: [{ id: 'discord-user', provider: 'discord' }],
    },
    'member',
  );
  assert.equal(user?.username, 'Discord user');
});

test('uses the Discord display name stored in Supabase user metadata', () => {
  const user = sessionUserFromSupabaseUser(
    {
      id: 'supabase-user',
      user_metadata: { full_name: 'kiyang#0' },
      identities: [{ id: 'discord-user', provider: 'discord' }],
    },
    'member',
  );
  assert.equal(user?.username, 'kiyang#0');
});

test('uses the forwarded ngrok origin for redirects', () => {
  const headers: Record<string, string> = {
    host: 'localhost:3000',
    'x-forwarded-host': 'example.ngrok-free.dev',
    'x-forwarded-proto': 'https',
  };

  assert.equal(
    requestOrigin((name) => headers[name] ?? null, 'http://localhost:3000'),
    'https://example.ngrok-free.dev',
  );
});

test('keeps direct local redirects on the local origin', () => {
  const headers: Record<string, string> = { host: 'localhost:3000' };

  assert.equal(
    requestOrigin((name) => headers[name] ?? null, 'http://localhost:3000'),
    'http://localhost:3000',
  );
});
