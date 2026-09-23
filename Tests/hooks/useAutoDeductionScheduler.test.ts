/**
 * Phase 2 unit tests for auto-deduction identity helpers and scheduling slots.
 * Does not require Android runtime. PendingIntent URI identity is validated
 * at the native layer (see AutoDeductionContract.occurrenceUri); these tests
 * cover the parallel JS occurrence-key contract and multi-dose amount isolation.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import {
  getAutoDeductionSlotsForDate,
  autoDeductionScheduleKey,
  localEpochMs,
  tomorrowDateString,
  isFireRetryRecoveryPending } from '../../src/hooks/useAutoDeductionScheduler';
import { autoDeductionOccurrenceKey } from '../../src/utils/autoDeductionNativeIdentity';
import { getAutoDeductionDefinitionForDate } from '../../src/utils/autoDeductionDefinition';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('auto-deduction occurrence identity (full key, not hash)', () => {
  it('same med + dose + date → same key', () => {
    const a = autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14');
    const b = autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14');
    expect(a).toBe(b);
  });

  it('different dose → different full key (not merely different hash)', () => {
    const a = autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14');
    const b = autoDeductionOccurrenceKey('m1', 'd2', '2026-09-14');
    expect(a).not.toBe(b);
    // Full identity includes doseId literally — collision-free by construction
    expect(a.includes('d1')).toBe(true);
    expect(b.includes('d2')).toBe(true);
  });

  it('different date → different full key', () => {
    const a = autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14');
    const b = autoDeductionOccurrenceKey('m1', 'd1', '2026-09-15');
    expect(a).not.toBe(b);
    expect(a.endsWith('2026-09-14') || a.includes('2026-09-14')).toBe(true);
    expect(b.includes('2026-09-15')).toBe(true);
  });

  it('schedule key distinguishes date and dose', () => {
    expect(autoDeductionScheduleKey('m', 'd', '2026-09-14')).not.toBe(
      autoDeductionScheduleKey('m', 'd', '2026-09-15')
    );
    expect(autoDeductionScheduleKey('m', 'dA', '2026-09-14')).not.toBe(
      autoDeductionScheduleKey('m', 'dB', '2026-09-14')
    );
  });

  it('multi-dose same day yields three independent schedule keys', () => {
    const date = '2026-09-14';
    const kA = autoDeductionScheduleKey('M', 'dose-a', date);
    const kB = autoDeductionScheduleKey('M', 'dose-b', date);
    const kC = autoDeductionScheduleKey('M', 'dose-c', date);
    expect(new Set([kA, kB, kC]).size).toBe(3);
  });
});

describe('canonical Auto definition ownership', () => {
  it('scheduler slots are a direct projection of the canonical dated definition', () => {
    const med = baseMed({
      autoDeductEnabled: true,
      doseSchedule: [
        { id: ' dose-a ', amount: 1.5, time: '08:05' },
        { id: 'dose-b', amount: 2, time: '20:00' },
        { id: 'dose-a', amount: 99, time: '21:00' },
        { id: '', amount: 4, time: '22:00' },
        { id: 'bad-time', amount: 3, time: '25:00' },
      ],
    });

    const canonical = getAutoDeductionDefinitionForDate(med, '2026-09-14');
    expect(getAutoDeductionSlotsForDate(med, '2026-09-14')).toEqual(
      canonical.map((slot) => ({ ...slot }))
    );
  });
});

describe('multi-dose amount isolation', () => {
  it('uses exact dose.amount per slot', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'dose-a', amount: 1, time: '08:00' },
        { id: 'dose-b', amount: 2, time: '14:00' },
        { id: 'dose-c', amount: 3, time: '22:00' },
      ],
      dailyDose: 6,
    });
    const slots = getAutoDeductionSlotsForDate(med, '2026-09-14');
    expect(slots).toHaveLength(3);
    expect(slots.find((s) => s.doseId === 'dose-a')?.amount).toBe(1);
    expect(slots.find((s) => s.doseId === 'dose-b')?.amount).toBe(2);
    expect(slots.find((s) => s.doseId === 'dose-c')?.amount).toBe(3);
  });

  it('does not use dailyDose for multi-dose slots', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'dose-a', amount: 1.5, time: '09:00' }],
      dailyDose: 99,
    });
    const slots = getAutoDeductionSlotsForDate(med, '2026-09-14');
    expect(slots[0].amount).toBe(1.5);
  });
});

describe('no doseSchedule (doseSchedule-only scheduler)', () => {
  it('does not invent slots from reminder fields without explicit doseSchedule', () => {
    const med = baseMed({
      reminderEnabled: true,
      reminderTime: '08:30',
      dailyDose: 2,
      doseSchedule: undefined,
    });
    // Scheduler is doseSchedule-only; only the current explicit schedule is schedulable.
    expect(getAutoDeductionSlotsForDate(med, '2026-09-14')).toEqual([]);
  });

  it('schedules an explicit single-dose from doseSchedule id/amount/time', () => {
    const med = baseMed({
      reminderEnabled: true,
      reminderTime: '08:30',
      dailyDose: 2,
      doseSchedule: [{ id: 'dose-med-1-s1', amount: 2, time: '08:30' }],
    });
    const slots = getAutoDeductionSlotsForDate(med, '2026-09-14');
    expect(slots).toHaveLength(1);
    expect(slots[0].doseId).toBe('dose-med-1-s1');
    expect(slots[0].amount).toBe(2);
    expect(slots[0].time).toBe('08:30');
    expect(slots[0].doseId).not.toBe('legacy');
  });
});

describe('settings gate', () => {
  it('per-med disable yields no slots', () => {
    const med = baseMed({
      autoDeductEnabled: false,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    expect(getAutoDeductionSlotsForDate(med, '2026-09-14')).toEqual([]);
  });
});

describe('fire-retry recovery preservation', () => {
  const now = 1_000_000;

  it('protects a due retry-marked occurrence while the durable medication still wants that slot', () => {
    const med = baseMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
    });
    expect(
      isFireRetryRecoveryPending(
        {
          medicationId: 'med-1',
          doseId: 'dose-a',
          calendarDate: '2026-09-14',
          timeHhmm: '08:00',
          amount: 1,
          scheduledAtEpochMs: now,
          fireRetryCount: 3,
        },
        med,
        true,
        now
      )
    ).toBe(true);
  });

  it('does not protect a retry marker when global auto-deduct is disabled', () => {
    const med = baseMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
    });
    expect(
      isFireRetryRecoveryPending(
        {
          medicationId: 'med-1',
          doseId: 'dose-a',
          calendarDate: '2026-09-14',
          timeHhmm: '08:00',
          scheduledAtEpochMs: now,
          fireRetryCount: 1,
        },
        med,
        false,
        now
      )
    ).toBe(false);
  });

  it('does not protect a retry marker when the medication no longer wants that dose slot', () => {
    const med = baseMed({
      autoDeductEnabled: false,
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
    });
    expect(
      isFireRetryRecoveryPending(
        {
          medicationId: 'med-1',
          doseId: 'dose-a',
          calendarDate: '2026-09-14',
          scheduledAtEpochMs: now,
          fireRetryCount: 3,
        },
        med,
        true,
        now
      )
    ).toBe(false);
  });

  it('does not protect a future retry-marked schedule', () => {
    const med = baseMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
    });
    expect(
      isFireRetryRecoveryPending(
        {
          medicationId: 'med-1',
          doseId: 'dose-a',
          calendarDate: '2026-09-14',
          scheduledAtEpochMs: now + 10_000,
          fireRetryCount: 1,
        },
        med,
        true,
        now
      )
    ).toBe(false);
  });

  it('does not protect a schedule without a retry marker', () => {
    const med = baseMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
    });
    expect(
      isFireRetryRecoveryPending(
        {
          medicationId: 'med-1',
          doseId: 'dose-a',
          calendarDate: '2026-09-14',
          scheduledAtEpochMs: now,
          fireRetryCount: 0,
        },
        med,
        true,
        now
      )
    ).toBe(false);
  });
});

describe('local calendar helpers', () => {
  it('tomorrowDateString advances calendar day', () => {
    expect(tomorrowDateString('2026-09-14')).toBe('2026-09-15');
    expect(tomorrowDateString('2026-12-31')).toBe('2027-01-01');
  });

  it('localEpochMs produces finite time', () => {
    const ms = localEpochMs('2026-09-14', '08:00');
    expect(ms).not.toBeNull();
    expect(Number.isFinite(ms!)).toBe(true);
  });
});

describe('amount validation boundary (JS)', () => {
  it('rejects non-positive amounts at slot build', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'ok', amount: 1, time: '08:00' },
        { id: 'zero', amount: 0, time: '09:00' },
        { id: 'neg', amount: -1, time: '10:00' },
      ],
    });
    const slots = getAutoDeductionSlotsForDate(med, '2026-09-14');
    expect(slots.map((s) => s.doseId)).toEqual(['ok']);
  });
});

import {
  isMetadataOwnedByVersion,
  conditionalRollback,
  buildSchedulePayload } from '../../src/utils/autoDeductionScheduleOwnership';

describe('schedule metadata ownership / conditional rollback', () => {
  const key = 'sch:med\u001fdose\u001f2026-09-14';

  it('simple rollback: A writes, A fails → A metadata removed', () => {
    const store = new Map<string, string>();
    const versionA = 'v-A-1';
    store.set(
      key,
      buildSchedulePayload({
        medicationId: 'med',
        doseId: 'dose',
        calendarDate: '2026-09-14',
        timeHhmm: '08:00',
        amount: 1,
        scheduledAtEpochMs: 1,
        operationVersion: versionA,
      })
    );
    expect(conditionalRollback(store, key, versionA)).toBe(true);
    expect(store.has(key)).toBe(false);
  });

  it('stale rollback cannot remove newer metadata: A writes, B writes, A fails → B remains', () => {
    const store = new Map<string, string>();
    const versionA = 'v-A-1';
    const versionB = 'v-B-2';
    store.set(
      key,
      buildSchedulePayload({
        medicationId: 'med',
        doseId: 'dose',
        calendarDate: '2026-09-14',
        operationVersion: versionA,
      })
    );
    // B overwrites same occurrence key with newer version
    store.set(
      key,
      buildSchedulePayload({
        medicationId: 'med',
        doseId: 'dose',
        calendarDate: '2026-09-14',
        timeHhmm: '08:00',
        amount: 1,
        scheduledAtEpochMs: 2,
        operationVersion: versionB,
      })
    );
    expect(conditionalRollback(store, key, versionA)).toBe(false);
    expect(store.has(key)).toBe(true);
    const remaining = JSON.parse(store.get(key)!);
    expect(remaining.operationVersion).toBe(versionB);
  });

  it('successful newer schedule remains: A writes, B writes, B succeeds, A fails → B remains', () => {
    const store = new Map<string, string>();
    const versionA = 'v-A-1';
    const versionB = 'v-B-2';
    store.set(
      key,
      buildSchedulePayload({
        medicationId: 'med',
        doseId: 'dose',
        calendarDate: '2026-09-14',
        operationVersion: versionA,
      })
    );
    store.set(
      key,
      buildSchedulePayload({
        medicationId: 'med',
        doseId: 'dose',
        calendarDate: '2026-09-14',
        operationVersion: versionB,
      })
    );
    // B "succeeded" — no rollback for B
    // A fails
    expect(conditionalRollback(store, key, versionA)).toBe(false);
    expect(JSON.parse(store.get(key)!).operationVersion).toBe(versionB);
  });

  it('same occurrence identity → one current schedule entry after sequential writes', () => {
    const store = new Map<string, string>();
    store.set(key, buildSchedulePayload({ operationVersion: 'v1' }));
    store.set(key, buildSchedulePayload({ operationVersion: 'v2' }));
    store.set(key, buildSchedulePayload({ operationVersion: 'v3' }));
    expect(store.size).toBe(1);
    expect(JSON.parse(store.get(key)!).operationVersion).toBe('v3');
  });

  it('different occurrences are isolated', () => {
    const store = new Map<string, string>();
    const kA = 'sch:m\u001fd1\u001f2026-09-14';
    const kB = 'sch:m\u001fd2\u001f2026-09-14';
    store.set(kA, buildSchedulePayload({ operationVersion: 'va', doseId: 'd1' }));
    store.set(kB, buildSchedulePayload({ operationVersion: 'vb', doseId: 'd2' }));
    expect(conditionalRollback(store, kA, 'va')).toBe(true);
    expect(store.has(kA)).toBe(false);
    expect(store.has(kB)).toBe(true);
  });

  it('isMetadataOwnedByVersion rejects missing/empty version', () => {
    expect(isMetadataOwnedByVersion(null, 'v1')).toBe(false);
    expect(isMetadataOwnedByVersion('{"scheduleVersion":"v1"}', '')).toBe(false);
    expect(isMetadataOwnedByVersion('{"scheduleVersion":"v1"}', 'v2')).toBe(false);
    expect(isMetadataOwnedByVersion('{"scheduleVersion":"v1"}', 'v1')).toBe(false);
  });

  it('metadata without operationVersion is never owned by a versioned attempt', () => {
    // Metadata without operationVersion is never owned by a versioned attempt.
    expect(isMetadataOwnedByVersion('{"medicationId":"m"}', 'v-any')).toBe(false);
  });
});

import {
  runSerializedScheduleTxn,
  runSerializedCancelTxn,
  type SchedulerTxnState } from '../../src/utils/autoDeductionScheduleOwnership';

describe('scheduler transaction serialization (model)', () => {
  const key = 'sch:med\u001fdose\u001f2026-09-14';

  function emptyState(): SchedulerTxnState {
    return { metadata: new Map(), alarms: new Map() };
  }

  it('A then B → final metadata and alarm both B', () => {
    const state = emptyState();
    runSerializedScheduleTxn(state, key, { operationVersion: 'A', scheduledAtEpochMs: 1 }, true);
    runSerializedScheduleTxn(state, key, { operationVersion: 'B', scheduledAtEpochMs: 2 }, true);
    expect(JSON.parse(state.metadata.get(key)!).operationVersion).toBe('B');
    expect(state.alarms.get(key)?.version).toBe('B');
  });

  it('A fails then B succeeds → metadata and alarm both B', () => {
    const state = emptyState();
    runSerializedScheduleTxn(state, key, { operationVersion: 'A', scheduledAtEpochMs: 1 }, false);
    runSerializedScheduleTxn(state, key, { operationVersion: 'B', scheduledAtEpochMs: 2 }, true);
    expect(JSON.parse(state.metadata.get(key)!).operationVersion).toBe('B');
    expect(state.alarms.get(key)?.version).toBe('B');
  });

  it('serialized A-fail then B never yields metadata=B alarm=A', () => {
    const state = emptyState();
    // Under SCHEDULE_LOCK, B cannot install until A fully completes (including rollback).
    runSerializedScheduleTxn(state, key, { operationVersion: 'A', scheduledAtEpochMs: 1 }, false);
    runSerializedScheduleTxn(state, key, { operationVersion: 'B', scheduledAtEpochMs: 2 }, true);
    const metaV = JSON.parse(state.metadata.get(key)!).operationVersion;
    const alarmV = state.alarms.get(key)?.version;
    expect(metaV).toBe(alarmV);
    expect(metaV).toBe('B');
  });

  it('schedule then cancel → canceled final state', () => {
    const state = emptyState();
    runSerializedScheduleTxn(state, key, { operationVersion: 'A', scheduledAtEpochMs: 1 }, true);
    runSerializedCancelTxn(state, key);
    expect(state.metadata.has(key)).toBe(false);
    expect(state.alarms.get(key)).toBeNull();
  });

  it('cancel then schedule → scheduled final state', () => {
    const state = emptyState();
    runSerializedCancelTxn(state, key);
    runSerializedScheduleTxn(state, key, { operationVersion: 'A', scheduledAtEpochMs: 1 }, true);
    expect(JSON.parse(state.metadata.get(key)!).operationVersion).toBe('A');
    expect(state.alarms.get(key)?.version).toBe('A');
  });
});

describe('Exact Auto desired slots ignore reminder/dailyDose fields', () => {
  it('dailyDose change does not alter desired Exact slots when doseSchedule is unchanged', () => {
    const base = baseMed({
      autoDeductEnabled: true,
      dailyDose: 1,
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    const slotsA = getAutoDeductionSlotsForDate(base, '2026-09-14');
    const slotsB = getAutoDeductionSlotsForDate(
      { ...base, dailyDose: base.dailyDose + 99 },
      '2026-09-14'
    );
    expect(slotsA).toEqual(slotsB);
    expect(slotsA).toHaveLength(1);
    expect(slotsA[0].amount).toBe(1);
  });

  it('reminderTime change does not alter desired Exact slots when doseSchedule is unchanged', () => {
    const base = baseMed({
      autoDeductEnabled: true,
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    const slotsA = getAutoDeductionSlotsForDate(base, '2026-09-14');
    const slotsB = getAutoDeductionSlotsForDate(
      {
        ...base,
        reminderTime: '21:00',
        doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
      },
      '2026-09-14'
    );
    expect(slotsA).toEqual(slotsB);
  });

  it('reminderEnabled change does not alter desired Exact slots when doseSchedule is unchanged', () => {
    const base = baseMed({
      autoDeductEnabled: true,
      reminderEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    const slotsA = getAutoDeductionSlotsForDate(base, '2026-09-14');
    const slotsB = getAutoDeductionSlotsForDate(
      { ...base, reminderEnabled: false },
      '2026-09-14'
    );
    expect(slotsA).toEqual(slotsB);
  });
});
