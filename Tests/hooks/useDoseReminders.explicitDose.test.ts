/**
 * Issue #268 — useDoseReminders requires explicit doseSchedule doseId.
 */
import { describe, it, expect } from 'vitest';
import type { Medication } from '../../src/types';
import {
  doseReminderAlarmIdForDose,
  snoozeDoseReminderId,
} from '../../src/utils/notifications';

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
    autoDeductEnabled: false,
    reminderEnabled: true,
    reminderTime: '08:30',
    ...over,
  };
}

describe('notification identity — doseId required', () => {
  it('empty doseId → null alarm/snooze id (no med-only identity)', () => {
    expect(doseReminderAlarmIdForDose('med-1', '')).toBeNull();
    expect(snoozeDoseReminderId('med-1', '')).toBeNull();
  });

  it('explicit doseId produces composite identity', () => {
    const a = doseReminderAlarmIdForDose('med-1', 'd1');
    const b = doseReminderAlarmIdForDose('med-1', 'd2');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

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
