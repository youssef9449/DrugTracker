/**
 * Issue #268 — doseSchedule is the only dose source (no legacy synthetic rows).
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import {
  getDoseScheduleForUI,
  getCardDoseToggleTarget,
  getAutoRestorableDose,
  getNextDoseAmount,
} from '../../src/utils/doseSchedule';
import { getAutoDeductionSlotsForDate } from '../../src/hooks/useAutoDeductionScheduler';

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

describe('getDoseScheduleForUI — explicit only', () => {
  it('returns empty when doseSchedule missing (no dailyDose/reminderTime invention)', () => {
    const med = baseMed({ doseSchedule: undefined });
    expect(getDoseScheduleForUI(med)).toEqual([]);
  });

  it('preserves existing explicit schedule ids/amounts/times', () => {
    const schedule = [
      { id: 'keep-a', amount: 1, time: '08:00' },
      { id: 'keep-b', amount: 2, time: '20:00' },
    ];
    const med = baseMed({ doseSchedule: schedule });
    const ui = getDoseScheduleForUI(med);
    expect(ui.map((d) => d.id)).toEqual(['keep-a', 'keep-b']);
    expect(ui.map((d) => d.amount)).toEqual([1, 2]);
  });
});

describe('getAutoDeductionSlotsForDate — doseSchedule only', () => {
  it('explicit single-dose → one slot with correct id/amount/time', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:30' }],
    });
    const slots = getAutoDeductionSlotsForDate(med, '2026-09-18');
    expect(slots).toEqual([
      {
        medId: 'med-1',
        doseId: 'd1',
        time: '08:30',
        amount: 2,
        calendarDate: '2026-09-18',
      },
    ]);
    expect(slots[0].doseId).not.toBe('legacy');
  });

  it('explicit multi-dose → one slot per row', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
        { id: 'c', amount: 3, time: '22:00' },
      ],
    });
    const slots = getAutoDeductionSlotsForDate(med, '2026-09-18');
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.doseId)).toEqual(['a', 'b', 'c']);
    expect(slots.map((s) => s.amount)).toEqual([1, 2, 3]);
  });

  it('does not use reminderTime/dailyDose when doseSchedule is absent', () => {
    const med = baseMed({
      doseSchedule: undefined,
      reminderEnabled: true,
      reminderTime: '08:30',
      dailyDose: 2,
    });
    expect(getAutoDeductionSlotsForDate(med, '2026-09-18')).toEqual([]);
  });
});

describe('card helpers — no legacy fallback', () => {
  it('getCardDoseToggleTarget with no schedule → cannot take/restore', () => {
    const med = baseMed({ doseSchedule: undefined });
    const t = getCardDoseToggleTarget(med, new Date('2026-09-14T15:00:00'));
    expect(t.canTake).toBe(false);
    expect(t.canRestore).toBe(false);
    expect(t.amount).toBe(0);
  });

  it('getAutoRestorableDose with no schedule → null', () => {
    const med = baseMed({ doseSchedule: undefined });
    expect(
      getAutoRestorableDose(med, new Date('2026-09-14T15:00:00'), '2026-09-14')
    ).toBeNull();
  });

  it('getNextDoseAmount with no schedule → 0', () => {
    expect(getNextDoseAmount(baseMed({ doseSchedule: undefined }))).toBe(0);
  });
});
