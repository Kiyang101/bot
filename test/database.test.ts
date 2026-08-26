import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSupabaseResult, DatabaseError } from '../src/lib/database';

test('assertSupabaseResult turns a Supabase error into an actionable DatabaseError', () => {
  assert.throws(
    () =>
      assertSupabaseResult('read BotRuntime', {
        data: null,
        error: { message: 'connection refused' },
      }),
    (error: unknown) =>
      error instanceof DatabaseError && error.message.includes('read BotRuntime: connection refused'),
  );
});
