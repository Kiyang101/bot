export class DatabaseError extends Error {
  constructor(operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'DatabaseError';
  }
}

export interface SupabaseErrorLike {
  message: string;
}

export function assertSupabaseResult<T>(
  operation: string,
  result: { data: T; error: SupabaseErrorLike | null },
): T {
  if (result.error) throw new DatabaseError(operation, result.error.message);
  return result.data;
}

export const VoiceAction = {
  JOIN: 'JOIN',
  LEAVE: 'LEAVE',
  MOVE: 'MOVE',
} as const;

export type VoiceAction = (typeof VoiceAction)[keyof typeof VoiceAction];

export type BotStatus = 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'ERROR';
