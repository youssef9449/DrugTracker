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

describe('auto-deduction occurrence identity', () => {
  it('same med + dose + date → same key', () => {
    const a = autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14');
    const b = autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14');
    expect(a).toBe(b);
  });

  it('different dose → different key', () => {
    expect(autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14')).not.toBe(
      autoDeductionOccurrenceKey('m1', 'd2', '2026-09-14')
    );
  });

  it('different date → different key', () => {
    expect(autoDeductionOccurrenceKey('m1', 'd1', '2026-09-14')).not.toBe(
      autoDeductionOccurrenceKey('m1', 'd1', '2026-09-15')
    );
  });

  it('schedule key distinguishes date', () => {
    expect(autoDeductionScheduleKey('m', 'd', '2026-09-14')).not.toBe(
      autoDeductionScheduleKey('m', 'd', '2026-09-15')
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
