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
} from '../../src/hooks/useAutoDeductionScheduler';
import { autoDeductionOccurrenceKey } from '../../src/utils/autoDeductionNative';
import { LEGACY_DOSE_ID } from '../../src/utils/notifications';

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
    lastSyncDate: '2026-09-14',
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

describe('legacy single-dose', () => {
  it('uses LEGACY_DOSE_ID and dailyDose', () => {
    const med = baseMed({
      reminderTime: '08:30',
      dailyDose: 2,
      doseSchedule: undefined,
    });
    const slots = getAutoDeductionSlotsForDate(med, '2026-09-14');
    expect(slots).toHaveLength(1);
    expect(slots[0].doseId).toBe(LEGACY_DOSE_ID);
    expect(slots[0].amount).toBe(2);
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
