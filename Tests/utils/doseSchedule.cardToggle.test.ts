import { describe, it, expect } from 'vitest';
import type { Medication } from '@/types';
import { getCardDoseToggleTarget, getNextScheduledDose, getAutoRestorableDose, hasAutoRestorableDoseToday } from '@/utils/doseSchedule';
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
    const early = new Date(`${getTodayDateString()}T06:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        doseSchedule: [{ id: 's1', amount: 2, time: '08:00' }],
        dosesPerDay: 1,
      }),
      early
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

  it('multi: when d1+d2 manual, restore prefers first chronological manual d1', () => {
    const today = getTodayDateString();
    // 22:00 so d3 is also completed (auto); d1+d2 are manual
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseConsumption: { d1: today, d2: today },
      }),
      new Date(`${today}T22:00:00`)
    );
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
  });

  it('multi: all manual including d3 — restore first chronological manual d1 (amount 1)', () => {
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

  it('multi: only d3 manual with earlier open slots → Restore d3 (manual wins over incomplete)', () => {
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
    // Manual consume has priority over later/earlier incomplete Take targets.
    expect(t.canRestore).toBe(true);
    expect(t.canTake).toBe(false);
    expect(t.doseId).toBe('d3');
    expect(t.amount).toBe(2);
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

  it('auto-deduct-only single slot: no Card Restore (manual consume never happened)', () => {
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
    // Auto-only completion is not restorable from the Card toggle.
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(false);
    expect(t.doseId).toBe('d1');
    expect(t.amount).toBe(1);
  });

  it('auto-deducted earlier slot: Card Take advances to next incomplete (not Restore auto)', () => {
    const today = getTodayDateString();
    const noon = new Date(`${today}T12:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        autoDeductEnabled: true,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        // no doseConsumption — d1 elapsed → auto completed; skip to d2 Take
      }),
      noon
    );
    expect(t.canRestore).toBe(false);
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('d2');
    expect(t.amount).toBe(1);
  });

  it('after skip of auto d1, target advances to next incomplete', () => {
    const today = getTodayDateString();
    const noon = new Date(`${today}T12:00:00`);
    const t = getCardDoseToggleTarget(
      makeMed({
        dailyDose: 4,
        autoDeductEnabled: true,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseSkippedHistory: { d1: [today] },
      }),
      noon
    );
    expect(t.canTake).toBe(true);
    expect(t.doseId).toBe('d1'); // skipped → not completed → Take d1 again
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


describe('getAutoRestorableDose — pure auto-completed only', () => {
  const today = getTodayDateString();

  it('returns null when medication autoDeductEnabled is false', () => {
    const now = new Date(`${today}T16:00:00`);
    const dose = getAutoRestorableDose(
      makeMed({
        autoDeductEnabled: false,
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
      }),
      now,
      today
    );
    expect(dose).toBeNull();
    expect(hasAutoRestorableDoseToday(
      makeMed({ autoDeductEnabled: false, doseSchedule: multiSchedule, dosesPerDay: 3 }),
      now,
      today
    )).toBe(false);
  });

  it('returns first elapsed pure-auto dose (d1) when time passed and no marks', () => {
    const now = new Date(`${today}T15:00:00`);
    const dose = getAutoRestorableDose(
      makeMed({ doseSchedule: multiSchedule, dosesPerDay: 3 }),
      now,
      today
    );
    expect(dose).not.toBeNull();
    expect(dose!.id).toBe('d1');
    expect(dose!.amount).toBe(1);
  });

  it('skips manually consumed dose and returns next pure-auto', () => {
    const now = new Date(`${today}T15:00:00`);
    const dose = getAutoRestorableDose(
      makeMed({
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseConsumption: { d1: today },
      }),
      now,
      today
    );
    expect(dose).not.toBeNull();
    expect(dose!.id).toBe('d2');
  });

  it('skips already-skipped dose', () => {
    const now = new Date(`${today}T15:00:00`);
    const dose = getAutoRestorableDose(
      makeMed({
        doseSchedule: multiSchedule,
        dosesPerDay: 3,
        doseSkippedHistory: { d1: [today] },
      }),
      now,
      today
    );
    expect(dose).not.toBeNull();
    expect(dose!.id).toBe('d2');
  });

  it('returns null before any dose time has elapsed', () => {
    const early = new Date(`${today}T06:00:00`);
    const dose = getAutoRestorableDose(
      makeMed({ doseSchedule: multiSchedule, dosesPerDay: 3 }),
      early,
      today
    );
    expect(dose).toBeNull();
  });

  it('legacy: returns synthetic dose when time elapsed and not lastConsumed', () => {
    const now = new Date(`${today}T16:00:00`);
    const dose = getAutoRestorableDose(
      makeMed({ dailyDose: 3, reminderTime: '09:00', autoDeductEnabled: true }),
      now,
      today
    );
    expect(dose).not.toBeNull();
    expect(dose!.id).toBe(''); // no real doseId
    expect(dose!.amount).toBe(3);
  });

  it('legacy: null when lastConsumedDate is today', () => {
    const now = new Date(`${today}T16:00:00`);
    const dose = getAutoRestorableDose(
      makeMed({
        dailyDose: 3,
        reminderTime: '09:00',
        lastConsumedDate: today,
      }),
      now,
      today
    );
    expect(dose).toBeNull();
  });

  it('does not treat pure auto as getCardDoseToggleTarget canRestore', () => {
    const now = new Date(`${today}T15:00:00`);
    const med = makeMed({ doseSchedule: multiSchedule, dosesPerDay: 3 });
    const toggle = getCardDoseToggleTarget(med, now, today);
    expect(toggle.canRestore).toBe(false);
    expect(getAutoRestorableDose(med, now, today)).not.toBeNull();
  });
});

describe('getCardDoseToggleTarget — medication-level Auto only', () => {
  const today = getTodayDateString();

  it('Medication ON + elapsed: auto-only → canTake=false, canRestore=false', () => {
    const late = new Date(`${today}T20:00:00`);
    const med = makeMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      dosesPerDay: 1,
    });
    const t = getCardDoseToggleTarget(med, late, today);
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(false);
    expect(t.doseId).toBe('d1');
  });

  it('Medication OFF + elapsed: canTake=true (manual mode)', () => {
    const late = new Date(`${today}T20:00:00`);
    const med = makeMed({
      autoDeductEnabled: false,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      dosesPerDay: 1,
    });
    const t = getCardDoseToggleTarget(med, late, today);
    expect(t.canTake).toBe(true);
    expect(t.canRestore).toBe(false);
    expect(t.doseId).toBe('d1');
  });

  it('Medication ON + manual consume: canRestore same doseId', () => {
    const late = new Date(`${today}T20:00:00`);
    const med = makeMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
      dosesPerDay: 1,
      doseConsumption: { d1: today },
    });
    const t = getCardDoseToggleTarget(med, late, today);
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(true);
    expect(t.doseId).toBe('d1');
  });
});
