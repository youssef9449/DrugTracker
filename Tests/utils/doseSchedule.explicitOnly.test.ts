/**
 * Issue #268 — doseSchedule is the only dose source (no med-only / legacy path).
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import {
  getDoseScheduleForUI,
  getCardDoseToggleTarget } from '../../src/utils/doseSchedule';
import { getAutoDeductionSlotsForDate } from '../../src/hooks/useAutoDeductionScheduler';
import { getDoseReminderSlots } from '../../src/hooks/useDoseReminderScheduler';

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
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '08:30',
    ...over,
  };
}

describe('explicit schedule only', () => {
  it('getDoseScheduleForUI without schedule → []', () => {
    expect(getDoseScheduleForUI(baseMed({ doseSchedule: undefined }))).toEqual([]);
  });

  it('getAutoDeductionSlotsForDate uses schedule rows only', () => {
    const slots = getAutoDeductionSlotsForDate(
      baseMed({
        doseSchedule: [
          { id: 'a', amount: 1, time: '08:00' },
          { id: 'b', amount: 2, time: '20:00' },
        ],
      }),
      '2026-09-18'
    );
    expect(slots.map((s) => s.doseId)).toEqual(['a', 'b']);
    expect(slots.map((s) => s.amount)).toEqual([1, 2]);
  });

  it('no doseSchedule → no Exact slots and no reminder slots', () => {
    const med = baseMed({
      doseSchedule: undefined,
      reminderTime: '08:30',
      dailyDose: 2,
    });
    expect(getAutoDeductionSlotsForDate(med, '2026-09-18')).toEqual([]);
    expect(getDoseReminderSlots(med)).toEqual([]);
  });

  it('getCardDoseToggleTarget does not use dailyDose fallback', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd1', amount: 3, time: '09:00' }],
      dailyDose: 99,
    });
    // All slots "completed" path uses nominal amount only
    const t = getCardDoseToggleTarget(
      {
        ...med,
        doseConsumptionHistory: { d1: ['2026-09-14'] },
      },
      new Date('2026-09-14T22:00:00'),
      '2026-09-14'
    );
    // amount must not be 99
    expect(t.amount).not.toBe(99);
  });



  it('global Auto OFF allows manual Take while preserving the medication-level Auto preference', () => {
    const med = baseMed({
      autoDeductEnabled: true,
      doseSchedule: [{ id: 'd1', amount: 3, time: '09:00' }],
    });
    const target = getCardDoseToggleTarget(
      med,
      new Date('2026-09-14T22:00:00'),
      '2026-09-14',
      false
    );
    expect(med.autoDeductEnabled).toBe(true);
    expect(target.doseId).toBe('d1');
    expect(target.canTake).toBe(true);
    expect(target.canRestore).toBe(false);
  });

  it('empty doseId rows are ignored by reminder scheduling sources', () => {
    const med = baseMed({
      doseSchedule: [{ id: '', amount: 1, time: '08:00' }],
    });
    expect(getDoseReminderSlots(med)).toEqual([]);
  });
});
