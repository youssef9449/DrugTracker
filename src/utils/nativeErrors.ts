export type NativeErrorCode =
  | 'invalid_argument'
  | 'not_android'
  | 'permission_denied'
  | 'persistence_failed'
  | 'ownership_lost'
  | 'recovery_required'
  | 'platform_failure'
  | 'unknown';

export class NativeBoundaryError extends Error {
  readonly code: NativeErrorCode;

  constructor(code: NativeErrorCode, message: string) {
    super(message);
    this.name = 'NativeBoundaryError';
    this.code = code;
  }
}

export function classifyNativeError(
  message: string | undefined,
  fallback: NativeErrorCode = 'platform_failure'
): NativeErrorCode {
  const value = (message ?? '').toLowerCase();
  if (value.includes('invalid_') || value.includes('missing_')) return 'invalid_argument';
  if (value === 'not_android') return 'not_android';
  if (value.includes('permission')) return 'permission_denied';
  if (value.includes('persist') || value.includes('storage') || value.includes('commit')) return 'persistence_failed';
  if (value.includes('ownership') || value.includes('stale') || value.includes('cancelled')) return 'ownership_lost';
  if (value.includes('recover') || value.includes('reconcile')) return 'recovery_required';
  return fallback;
}

export function toNativeBoundaryError(
  error: unknown,
  fallback: NativeErrorCode = 'platform_failure'
): NativeBoundaryError {
  if (error instanceof NativeBoundaryError) return error;
  const message = error instanceof Error ? error.message : String(error ?? 'native operation failed');
  return new NativeBoundaryError(classifyNativeError(message, fallback), message);
}
