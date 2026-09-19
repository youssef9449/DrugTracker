/**
 * Issue #268 — legacy single-dose → explicit doseSchedule migration.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import {
  migrateLegacySingleDoseToSchedule,
  migrateMedicationsLegacySingleDose,
  stableMigratedLegacyDoseId,
  hasValidExplicitDoseSchedule,
} from '../../src/utils/legacySingleDoseMigration';
import { getAutoDeductionSlotsForDate } from '../../src/hooks/useAutoDeductionScheduler';
import { LEGACY_DOSE_ID } from '../../src/utils/legacyDoseId';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-14',
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '08:30',
    ...over,
  };
}

describe('stableMigratedLegacyDoseId', () => {
  it('is deterministic and not LEGACY_DOSE_ID', () => {
    expect(stableMigratedLegacyDoseId('med-1')).toBe('dose-med-1-s1');
    expect(stableMigratedLegacyDoseId('med-1')).toBe(stableMigratedLegacyDoseId('med-1'));
    expect(stableMigratedLegacyDoseId('med-1')).not.toBe(LEGACY_DOSE_ID);
    expect(stableMigratedLegacyDoseId('med-2')).toBe('dose-med-2-s1');
  });
});

describe('migrateLegacySingleDoseToSchedule', () => {
  it('legacy valid → explicit one-dose schedule with amount/time preserved', () => {
    const med = baseMed({ doseSchedule: undefined, currentPills: 30 });
    const next = migrateLegacySingleDoseToSchedule(med);
    expect(next.doseSchedule).toEqual([
      { id: 'dose-med-1-s1', amount: 2, time: '08:30' },
    ]);
    expect(next.doseSchedule![0].amount).toBe(med.dailyDose);
    expect(next.doseSchedule![0].time).toBe(med.reminderTime);
    // No stock mutation
    expect(next.currentPills).toBe(30);
    expect(next.lastSyncDate).toBe(med.lastSyncDate);
    expect(next.dailyDose).toBe(2);
    expect(next.reminderEnabled).toBe(true);
    expect(next.reminderTime).toBe('08:30');
  });

  it('migration twice is idempotent — same id, no duplicate doses', () => {
    const med = baseMed({ doseSchedule: undefined });
    const once = migrateLegacySingleDoseToSchedule(med);
    const twice = migrateLegacySingleDoseToSchedule(once);
    expect(twice.doseSchedule).toEqual(once.doseSchedule);
    expect(twice.doseSchedule).toHaveLength(1);
    expect(twice.doseSchedule![0].id).toBe(once.doseSchedule![0].id);
  });

  it('existing valid single-dose schedule is unchanged', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'custom-id', amount: 3, time: '10:00' }],
      dailyDose: 3,
    });
    const next = migrateLegacySingleDoseToSchedule(med);
    expect(next).toBe(med);
    expect(next.doseSchedule![0].id).toBe('custom-id');
  });

  it('existing valid multi-dose schedule is unchanged', () => {
    const schedule = [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 2, time: '20:00' },
    ];
    const med = baseMed({ doseSchedule: schedule, dailyDose: 3 });
    const next = migrateLegacySingleDoseToSchedule(med);
    expect(next).toBe(med);
    expect(next.doseSchedule).toEqual(schedule);
  });

  it('invalid/missing legacy data does not invent amount or time', () => {
    const noReminder = baseMed({
      doseSchedule: undefined,
      reminderEnabled: false,
      reminderTime: '08:30',
      dailyDose: 2,
    });
    expect(migrateLegacySingleDoseToSchedule(noReminder)).toBe(noReminder);

    const badTime = baseMed({
      doseSchedule: undefined,
      reminderEnabled: true,
      reminderTime: 'bad',
      dailyDose: 2,
    });
    expect(migrateLegacySingleDoseToSchedule(badTime)).toBe(badTime);

    const zeroDose = baseMed({
      doseSchedule: undefined,
      reminderEnabled: true,
      reminderTime: '08:30',
      dailyDose: 0,
    });
    expect(migrateLegacySingleDoseToSchedule(zeroDose)).toBe(zeroDose);
  });

  it('invalid doseSchedule rows with valid legacy fields are replaced once', () => {
    const med = baseMed({
      doseSchedule: [{ id: '', amount: 0, time: 'xx' }],
      reminderEnabled: true,
      reminderTime: '09:15',
      dailyDose: 1.5,
    });
    expect(hasValidExplicitDoseSchedule(med)).toBe(false);
    const next = migrateLegacySingleDoseToSchedule(med);
    expect(next.doseSchedule).toEqual([
      { id: 'dose-med-1-s1', amount: 1.5, time: '09:15' },
    ]);
  });
});

describe('migrate then Exact scheduler slots', () => {
  it('after migration, slots use explicit doseSchedule — not LEGACY_DOSE_ID', () => {
    const legacy = baseMed({ doseSchedule: undefined });
    const migrated = migrateLegacySingleDoseToSchedule(legacy);
    const slots = getAutoDeductionSlotsForDate(migrated, '2026-09-18');
    expect(slots).toHaveLength(1);
    expect(slots[0].doseId).toBe(stableMigratedLegacyDoseId('med-1'));
    expect(slots[0].doseId).not.toBe(LEGACY_DOSE_ID);
    expect(slots[0].amount).toBe(2);
    expect(slots[0].time).toBe('08:30');
    expect(slots[0].calendarDate).toBe('2026-09-18');
  });

  it('batch migration marks changed and is stable on second pass', () => {
    const meds = [
      baseMed({ id: 'a', doseSchedule: undefined }),
      baseMed({
        id: 'b',
        doseSchedule: [{ id: 'keep', amount: 1, time: '07:00' }],
      }),
    ];
    const first = migrateMedicationsLegacySingleDose(meds);
    expect(first.changed).toBe(true);
    expect(first.medications[0].doseSchedule![0].id).toBe('dose-a-s1');
    expect(first.medications[1].doseSchedule![0].id).toBe('keep');

    const second = migrateMedicationsLegacySingleDose(first.medications);
    expect(second.changed).toBe(false);
    expect(second.medications[0].doseSchedule).toEqual(
      first.medications[0].doseSchedule
    );
  });
});
