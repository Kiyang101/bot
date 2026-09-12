import { describe, expect, test } from 'vitest';
import { isRecoverableSupabaseAuthError } from './middleware';

describe('isRecoverableSupabaseAuthError', () => {
  test('treats refresh token replay errors as recoverable session failures', () => {
    const error = {
      name: 'AuthApiError',
      status: 400,
      code: 'refresh_token_already_used',
    } as { name: string; status?: number; code?: string };

    expect(isRecoverableSupabaseAuthError(error)).toBe(true);
  });

  test('ignores ordinary auth errors that should still surface', () => {
    const error = {
      name: 'AuthApiError',
      status: 400,
      code: 'invalid_grant',
    } as { name: string; status?: number; code?: string };

    expect(isRecoverableSupabaseAuthError(error)).toBe(false);
  });
});
