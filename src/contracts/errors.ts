import type { Failure, Result } from './types.js';

export class CoreError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly retryable = false, public readonly details: Record<string, unknown> = {}) {
    super(message); this.name = 'CoreError';
  }
  toFailure(): Failure {
    return { ok: false, error: { code: this.code, message: this.message, retryable: this.retryable, details: this.details } };
  }
}
export async function resultOf<T>(operation: () => T | Promise<T>): Promise<Result<T>> {
  try { return { ok: true, data: await operation() }; }
  catch (error) { if (error instanceof CoreError) return error.toFailure(); throw error; }
}
export function invalid(message: string): never { throw new CoreError('INVALID_ARGUMENT', message); }
