import { describe, expect, it } from 'vitest';
import {
  resolveAutoDeductionSchedulingDecision,
  isAutoDeductionBlockedByExactAlarmPermission,
} from '@/utils/autoDeductionSchedulingGate';
import {
  resolveCriticalStockSchedulingDecision,
} from '@/hooks/useCriticalAlarmScheduler';
import { isFireRetryRecoveryPending } from '@/hooks/useAutoDeductionScheduler';

const ready = {
  hydrated: true,
  isFirstRun: false,
} as const;

describe('Auto-Deduction × Exact Alarm gate (#500)', () => {
  it('schedules only with granted permission when ready', () => {
    expect(
      resolveAutoDeductionSchedulingDecision({ ...ready, exactAlarmPermission: 'granted' })
    ).toEqual({ action: 'schedule' });
  });

  it('denied → cancel armed alarms and wait (configuration intact)', () => {
    expect(
      resolveAutoDeductionSchedulingDecision({ ...ready, exactAlarmPermission: 'denied' })
    ).toEqual({
      action: 'cancel_armed_and_wait',
      reason: 'exact_alarm_permission_denied',
    });
  });

  it('Global OFF cancels armed Auto regardless of exact-alarm capability state', () => {
    for (const exactAlarmPermission of [
      null,
      'unknown',
      'denied',
      'granted',
      'unsupported',
    ] as const) {
      expect(
        resolveAutoDeductionSchedulingDecision({
          ...ready,
          exactAlarmPermission,
          globalAutoDeductEnabled: false,
        })
      ).toEqual({
        action: 'cancel_armed_and_wait',
        reason: 'global_auto_deduct_disabled',
      });
    }
  });

  it('unknown capability waits without destructive action', () => {
    expect(
      resolveAutoDeductionSchedulingDecision({ ...ready, exactAlarmPermission: null })
    ).toEqual({ action: 'wait', reason: 'exact_alarm_capability_unknown' });
    expect(
      resolveAutoDeductionSchedulingDecision({ ...ready, exactAlarmPermission: 'unsupported' })
    ).toEqual({ action: 'wait', reason: 'exact_alarm_capability_unknown' });
  });

  it('not hydrated / first run wait before capability matters', () => {
    expect(
      resolveAutoDeductionSchedulingDecision({
        hydrated: false,
        isFirstRun: false,
        exactAlarmPermission: 'granted',
      })
    ).toEqual({ action: 'wait', reason: 'not_hydrated' });
    expect(
      resolveAutoDeductionSchedulingDecision({
        hydrated: true,
        isFirstRun: true,
        exactAlarmPermission: 'granted',
      })
    ).toEqual({ action: 'wait', reason: 'first_run' });
  });

  it('denied → granted transition restores scheduling (#500 denied→granted)', () => {
    const denied = resolveAutoDeductionSchedulingDecision({ ...ready, exactAlarmPermission: 'denied' });
    expect(denied.action).toBe('cancel_armed_and_wait');
    const granted = resolveAutoDeductionSchedulingDecision({ ...ready, exactAlarmPermission: 'granted' });
    expect(granted.action).toBe('schedule');
  });

  it('blocked-state helper tracks denial only', () => {
    expect(isAutoDeductionBlockedByExactAlarmPermission('denied')).toBe(true);
    expect(isAutoDeductionBlockedByExactAlarmPermission('granted')).toBe(false);
    expect(isAutoDeductionBlockedByExactAlarmPermission(null)).toBe(false);
  });
});

describe('Critical Stock × Exact Alarm gate (#504)', () => {
  const base = { ...ready, criticalStockAlertsEnabled: true };

  it('denied → cancel armed and wait; preference stays intact by contract', () => {
    expect(
      resolveCriticalStockSchedulingDecision({ ...base, exactAlarmPermission: 'denied' })
    ).toEqual({
      action: 'cancel_armed_and_wait',
      reason: 'exact_alarm_permission_denied',
    });
  });

  it('denied → granted transition restores scheduling (#504 denied→granted)', () => {
    const denied = resolveCriticalStockSchedulingDecision({ ...base, exactAlarmPermission: 'denied' });
    expect(denied.action).toBe('cancel_armed_and_wait');
    const granted = resolveCriticalStockSchedulingDecision({ ...base, exactAlarmPermission: 'granted' });
    expect(granted).toEqual({ action: 'schedule' });
  });

  it('alerts-disabled is a cancel state; unknown capability waits', () => {
    expect(
      resolveCriticalStockSchedulingDecision({
        ...ready,
        criticalStockAlertsEnabled: false,
        exactAlarmPermission: 'granted',
      })
    ).toEqual({
      action: 'cancel_armed_and_wait',
      reason: 'critical_stock_alerts_disabled',
    });
    expect(
      resolveCriticalStockSchedulingDecision({ ...base, exactAlarmPermission: null })
    ).toEqual({ action: 'wait', reason: 'exact_alarm_capability_unknown' });
  });

  it('denial takes precedence over the preference-disabled cancel state', () => {
    expect(
      resolveCriticalStockSchedulingDecision({
        ...ready,
        criticalStockAlertsEnabled: false,
        exactAlarmPermission: 'denied',
      })
    ).toEqual({
      action: 'cancel_armed_and_wait',
      reason: 'exact_alarm_permission_denied',
    });
  });
});

describe('fire-retry recovery state is independent of preference gating (#535)', () => {
  const schedule = {
    medicationId: 'm',
    doseId: 'd',
    calendarDate: '2026-01-01',
    timeHhmm: '09:00',
    scheduledAtEpochMs: 1,
    fireRetryCount: 2,
  } as unknown as Parameters<typeof isFireRetryRecoveryPending>[0];

  it('retry evidence protects the row regardless of medication state', () => {
    expect(isFireRetryRecoveryPending(schedule, undefined, 0)).toBe(true);
  });

  it('no retry evidence → not protected', () => {
    const noRetry = { ...schedule, fireRetryCount: 0 };
    expect(isFireRetryRecoveryPending(noRetry, undefined, 0)).toBe(false);
  });
});
