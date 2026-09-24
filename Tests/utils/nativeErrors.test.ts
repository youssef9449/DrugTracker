import { describe, expect, it } from 'vitest';
import {
  NativeBoundaryError,
  classifyNativeError,
  classifyNativeFailure,
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

  it('converts thrown failures into a stable boundary result', () => {
    expect(toNativeBoundaryFailure(new Error('persist_failed'))).toEqual({
      ok: false,
      error: 'persist_failed',
      errorCode: 'persistence_failed',
    });
  });
});

describe('#534 structured native error-code migration', () => {
  it('classification prefers the structured code: changing the human-readable message does NOT change the category', () => {
    const reworded = {
      code: 'persist_failed',
      error: 'Could not write the schedule — the storage layer refused the update (0x11)',
    };
    expect(classifyNativeFailure(reworded)).toBe('persistence_failed');

    // The SAME known code with a COMPLETELY different (even Arabic) message
    // still classifies deterministically.
    expect(
      classifyNativeFailure({
        code: 'persist_failed',
        error: 'تعذّر الحفظ',
      })
    ).toBe('persistence_failed');

    // Known ownership code is never misread by message matching.
    expect(
      classifyNativeFailure({
        code: 'snapshot_stale',
        error: 'recover the reconcile storage commit now',
      })
    ).toBe('ownership_lost');
  });

  it('unknown/unstructured errors remain observable through the narrow message fallback and deterministic fallback', () => {
    // Unstructured external error with a recognizable keyword → narrow
    // string fallback still works.
    expect(
      classifyNativeFailure({ error: 'runtime permission not granted by user' })
    ).toBe('permission_denied');
    // No signal at all → deterministic caller-provided fallback.
    expect(classifyNativeFailure({ error: 'unrecognized transport shutdown' }, 'platform_failure')).toBe(
      'platform_failure'
    );
    expect(classifyNativeFailure({}, 'recovery_required')).toBe(
      'recovery_required'
    );
  });

  it('known persistence/ownership/recovery/platform codes map deterministically', () => {
    const codes: Array<[string, string]> = [
      ['persist_failed', 'persistence_failed'],
      ['retry_persist_failed', 'persistence_failed'],
      ['ownership_conflict', 'ownership_lost'],
      ['successor_catchup_failed', 'recovery_required'],
      ['restore_failed', 'recovery_required'],
      ['recovery_failed', 'recovery_required'],
      ['notification_post_failed', 'platform_failure'],
      ['channel_bootstrap_failed', 'platform_failure'],
      ['open_settings_failed', 'platform_failure'],
      ['invalid_snooze_request', 'invalid_argument'],
      ['notification_permission_required', 'permission_denied'],
      ['exact_alarm_permission_denied', 'permission_denied'],
    ];
    for (const [code, expected] of codes) {
      expect(
        classifyNativeFailure({ code, error: 'arbitrary wording' }),
        code
      ).toBe(expected);
    }
  });
});
