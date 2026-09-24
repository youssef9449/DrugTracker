import { describe, expect, it } from 'vitest';
import {
  isValidConsumptionLogRecord,
  isValidMedicationRecord,
  isValidCalendarDateString,
} from '@/utils/storage';
import { isValidTimeHhmm } from '@/utils/time';

/**
 * #518 regression: the persisted-state regexes previously used wrongly
 * escaped `\\d` literals that REJECTED valid HH:mm / YYYY-MM-DD values.
 * Valid values must pass; malformed ones must keep failing.
 */
describe('persisted-state validators accept valid values (#518)', () => {
  const baseMedication = {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: '#123456',
    createdAt: '2026-01-01T00:00:00.000Z',
    doseSchedule: [{ id: 'd1', amount: 1, time: '09:30' }],
  };

  it('accepts a medication with a valid 09:30 dose row', () => {
    expect(isValidMedicationRecord(baseMedication)).toBe(true);
  });

  it('accepts reminderTime 09:30', () => {
    expect(isValidMedicationRecord({ ...baseMedication, reminderTime: '09:30' })).toBe(true);
  });

  it('rejects impossible times like 25:00 / 99:99', () => {
    expect(
      isValidMedicationRecord({
        ...baseMedication,
        doseSchedule: [{ id: 'd1', amount: 1, time: '25:00' }],
      })
    ).toBe(false);
    expect(
      isValidMedicationRecord({ ...baseMedication, reminderTime: '99:99' })
    ).toBe(false);
  });

  it('accepts a consumption log with a valid 2026-01-01 date', () => {
    expect(
      isValidConsumptionLogRecord({
        id: 'log-1',
        medicationId: 'med-1',
        medicationName: 'Test Med',
        type: 'dose_taken',
        amount: -1,
        date: '2026-01-01',
        timestamp: '2026-01-01T09:30:00.000Z',
        description: 'x',
      })
    ).toBe(true);
  });

  it('rejects consumption logs with malformed dates', () => {
    expect(
      isValidConsumptionLogRecord({
        id: 'log-2',
        medicationId: 'med-1',
        medicationName: 'Test Med',
        type: 'dose_taken',
        amount: -1,
        date: '2026-13-01',
        timestamp: 'x',
        description: '',
      })
    ).toBe(false);
  });

  it('canonical HH:mm validator rejects malformed values consistently (#478)', () => {
    expect(isValidTimeHhmm('09:30')).toBe(true);
    expect(isValidTimeHhmm('23:59')).toBe(true);
    expect(isValidTimeHhmm('24:00')).toBe(false);
    expect(isValidTimeHhmm('25:00')).toBe(false);
    expect(isValidTimeHhmm('99:99')).toBe(false);
    expect(isValidTimeHhmm('9:30')).toBe(false);
    expect(isValidTimeHhmm('09:60')).toBe(false);
    expect(isValidTimeHhmm('')).toBe(false);
    expect(isValidTimeHhmm(null)).toBe(false);
  });

  it('canonical calendar-date validation enforces real dates incl. leap years (#523)', () => {
    expect(isValidCalendarDateString('2026-01-01')).toBe(true);
    expect(isValidCalendarDateString('2024-02-29')).toBe(true);
    expect(isValidCalendarDateString('2026-02-29')).toBe(false);
    expect(isValidCalendarDateString('2026-02-31')).toBe(false);
    expect(isValidCalendarDateString('2026-13-01')).toBe(false);
    expect(isValidCalendarDateString('2026-00-10')).toBe(false);
    expect(isValidCalendarDateString('2026-01-00')).toBe(false);
    expect(isValidCalendarDateString('20260101')).toBe(false);
  });
});
