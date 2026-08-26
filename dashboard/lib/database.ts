export class DatabaseError extends Error {
  constructor(operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'DatabaseError';
  }
}

export function assertSupabaseResult<T>(
  operation: string,
  result: { data: T; error: { message: string } | null },
): T {
  if (result.error) throw new DatabaseError(operation, result.error.message);
  return result.data;
}
