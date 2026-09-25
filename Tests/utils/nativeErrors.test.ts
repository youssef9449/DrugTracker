import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  NATIVE_CODE_CATEGORIES,
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

  it('bridge catch-path codes classify deterministically regardless of the human-readable message', () => {
    // Every stable code emitted by the plugin call.reject(msg, code) / result
    // catch paths maps through its table entry — the exception text is NEVER
    // consulted for classification.
    const cases: Array<[string, string]> = [
      ['schedule_occurrence_failed', 'platform_failure'],
      ['cancel_occurrence_failed', 'platform_failure'],
      ['invalidate_recurrence_failed', 'platform_failure'],
      ['list_fired_events_failed', 'platform_failure'],
      ['mark_reconciled_failed', 'platform_failure'],
      ['list_schedules_failed', 'platform_failure'],
      ['stock_init_failed', 'platform_failure'],
      ['foreground_stock_failed', 'platform_failure'],
      ['auto_stock_apply_failed', 'platform_failure'],
      ['critical_stock_schedule_failed', 'platform_failure'],
      ['critical_stock_cancel_failed', 'platform_failure'],
      ['dose_reminder_schedule_failed', 'platform_failure'],
      ['dose_reminder_cancel_failed', 'platform_failure'],
      ['dose_reminder_snooze_schedule_failed', 'platform_failure'],
      ['dose_reminder_snooze_cancel_failed', 'platform_failure'],
      ['dose_reminder_pending_state_failed', 'persistence_failed'],
      ['invalid_occurrence_resolution', 'invalid_argument'],
      ['invalid_snooze', 'invalid_argument'],
      ['invalid_schedule', 'invalid_argument'],
      ['missing_params', 'invalid_argument'],
      ['missing_schedule_fields', 'invalid_argument'],
    ];
    for (const [code, expected] of cases) {
      expect(
        classifyNativeFailure({
          code,
          // A message that would mislead the narrow substring classifier:
          // without the code, "recover...storage" would read as recovery.
          error: 'recover the storage state immediately: storage lost',
        }),
        code
      ).toBe(expected);
    }
  });

  it('an unknown structured code still falls back deterministically and keeps the raw error observable', () => {
    const failure = {
      code: 'totally_unregistered_token',
      error: 'raw native diagnostic text',
    };
    expect(classifyNativeFailure(failure, 'platform_failure')).toBe(
      'platform_failure'
    );
    // Same input, same fallback → same output (deterministic).
    expect(classifyNativeFailure(failure, 'platform_failure')).toBe(
      classifyNativeFailure(failure, 'platform_failure')
    );
  });

  it('the native and JS code vocabularies stay synchronized (#534)', () => {
    // NativeErrorCodes.java is the native authority: every double-quoted
    // token it registers must exist in the JS mapping table, so a native
    // code never silently degrades to message-wording classification.
    const nativeSource = fs.readFileSync(
      path.join(process.cwd(), 'native-android/alarm-runtime/NativeErrorCodes.java'),
      'utf8'
    );
    const tokens = new Set<string>();
    for (const match of nativeSource.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
      tokens.add(match[1]);
    }
    expect(tokens.size).toBeGreaterThan(0);
    const missing = [...tokens].filter((t) => !(t in NATIVE_CODE_CATEGORIES));
    expect(missing).toEqual([]);
  });
});
