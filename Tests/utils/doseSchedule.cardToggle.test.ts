import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import { getCardDoseToggleTarget, getNextScheduledDose } from '@/utils/doseSchedule';
import { getTodayDateString } from '@/utils/dateCalculations';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 20,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    autoDeductEnabled: true,
    ...overrides,
  };
}

const multiSchedule = [
  { id: 'd1', amount: 1, time: '08:00' },
  { id: 'd2', amount: 1, time: '14:00' },
  { id: 'd3', amount: 2, time: '20:00' },
];

describe('getCardDoseToggleTarget — stable doseId Take→Restore', () => {
  it('legacy: canTake when not consumed today', () => {
    const t = getCardDoseToggleTarget(makeMed({ dailyDose: 2 }));
    expect(t.canTake).toBe(true);
    expect(t.canRestore).toBe(false);
    expect(t.amount).toBe(2);
    expect(t.doseId).toBeUndefined();
  });

  it('legacy: canRestore when lastConsumedDate is today', () => {
    const today = getTodayDateString();
    const t = getCardDoseToggleTarget(makeMed({ dailyDose: 2, lastConsumedDate: today }));
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(true);
    expect(t.amount).toBe(2);
  });

  it('single-slot: amount is slot amount not dailyDose', () => {
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        doseSchedule: [{ id: 's1', amount: 2, time: '08:00' }],
        dosesPerDay: 1,
      })
    );
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('s1');
    expect(t.amount).toBe(2);
  });

  it('multi: first available is d1 before any consumption', () => {
    const early = new Date(`${getTodayDateString()}T06:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({ dailyDose: 4, doseSchedule: multiSchedule, dosesPerDay: 3 }),
      early
    );
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
  });

  it('multi: after manual d1, toggle stays on d1 for Restore (does NOT advance to d2)', () => {
    const today = getTodayDateString();
    const early = new Date(`${today}T06:00:00`);
    const med = makeMed({
      dailyDose: 4,
      doseSchedule: multiSchedule,
      dosesPerDay: 3,
      doseConsumption: { d1: today },
    });
    const t = getCardDoseToggleTarget(med, early);
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
    // next-dose helper may still see d2 as next incomplete — distinct responsibility
    const next = getNextScheduledDose(med, early);
    expect(next?.id).toBe('d2');
  });

  it('multi: after restoring d1 (no manual left), take target is d1 again', () => {
    const early = new Date(`${getTodayDateString()}T06:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({ dailyDose: 4, doseSchedule: multiSchedule, dosesPerDay: 3 }),
      early
    );
    expect(t.doseId).toBe('d1');
    expect(t.canTake).toBe(true);
  });

  it('multi: when d1+d2 manual, restore prefers earliest manual d1 (exact doseId)', () => {
    const today = getTodayDateString();
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseConsumption: { d1: today, d2: today },
      }),
      new Date(`${today}T18:00:00`)
    );
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
  });

  it('multi: all manual including d3 amount 2 — restore d1 first with amount 1 not dailyDose', () => {
    const today = getTodayDateString();
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseConsumption: { d1: today, d2: today, d3: today },
        lastConsumedDate: today,
      }),
      new Date(`${today}T22:00:00`)
    );
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
  });

  it('multi: only d3 manual with earlier open slots → Take earliest available d1', () => {
    const today = getTodayDateString();
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseConsumption: { d3: today },
      }),
      new Date(`${today}T06:00:00`)
    );
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
  });

  it('multi: only d3 manual and earlier slots auto-completed → Restore d3 amount 2', () => {
    const today = getTodayDateString();
    const late = new Date(`${today}T22:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseConsumption: { d3: today },
      }),
      late
    );
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d3');
    expect(t.amount).toBe(2);
  });

  it('auto-deduct-only slot is not restorable', () => {
    const today = getTodayDateString();
    const late = new Date(`${today}T20:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 1,
        autoDeductEnabled: true,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
        dosesPerDay: 1,
      }),
      late
    );
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(false);
  });

  it('auto-deducted earlier slot + future available: take future, do not restore auto', () => {
    const today = getTodayDateString();
    const noon = new Date(`${today}T12:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        autoDeductEnabled: true,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        // no doseConsumption — d1 elapsed → auto completed
      }),
      noon
    );
    expect(t.canRestore).toBe(false);
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('d2');
    expect(t.amount).toBe(1);
  });

  it('unsorted schedule still resolves by doseId after sort', () => {
    const early = new Date(`${getTodayDateString()}T06:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 3,
        doseSchedule: [
          { id: 'late', amount: 2, time: '20:00' },
          { id: 'early', amount: 1, time: '08:00' },
        ],
        dosesPerDay: 2,
      }),
      early
    );
    expect(t.doseId).toBe('early');
    expect(t.amount).toBe(1);
  });
});
