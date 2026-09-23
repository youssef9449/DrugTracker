import { describe, expect, it } from 'vitest';
import {
  NativeBoundaryError,
  classifyNativeError,
  toNativeBoundaryError,
  toNativeBoundaryFailure,
} from '@/utils/nativeErrors';

describe('native boundary error taxonomy', () => {
  it('classifies important machine-readable failure classes', () => {
    expect(classifyNativeError('invalid_amount')).toBe('invalid_argument');
    expect(classifyNativeError('not_android')).toBe('not_android');
    expect(classifyNativeError('rejected_persist_failed')).toBe('persistence_failed');
    expect(classifyNativeError('snapshot_stale')).toBe('ownership_lost');
    expect(classifyNativeError('recovery_required')).toBe('recovery_required');
  });

  it('preserves a structured error when a native boundary throws', () => {
    const error = toNativeBoundaryError(new Error('permission_denied'));
    expect(error).toBeInstanceOf(NativeBoundaryError);
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe('permission_denied');
  });
})

it('converts thrown failures into a stable boundary result', () => {
    expect(toNativeBoundaryFailure(new Error('persist_failed'))).toEqual({
      ok: false,
      error: 'persist_failed',
      errorCode: 'persistence_failed',
    });
  });
