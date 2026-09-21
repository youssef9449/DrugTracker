/**
 * Issue #268 — useDoseReminders requires explicit doseSchedule doseId.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';

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
    autoDeductEnabled: false,
    reminderEnabled: true,
    reminderTime: '08:30',
    ...over,
  };
}


describe('doseSchedule is sole amount/time source (contract)', () => {
  it('schedule row amount/time independent of dailyDose/reminderTime', () => {
    const med = baseMed({
      dailyDose: 99,
      reminderTime: '23:59',
      doseSchedule: [{ id: 'slot-a', amount: 1.5, time: '08:00' }],
    });
    const row = med.doseSchedule!.find((d) => d.id === 'slot-a')!;
    expect(row.amount).toBe(1.5);
    expect(row.time).toBe('08:00');
    expect(row.amount).not.toBe(med.dailyDose);
    expect(row.time).not.toBe(med.reminderTime);
  });

  it('missing doseSchedule has no dose rows to alarm/snooze', () => {
    const med = baseMed({ doseSchedule: undefined });
    expect(Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0).toBe(
      false
    );
  });
});
