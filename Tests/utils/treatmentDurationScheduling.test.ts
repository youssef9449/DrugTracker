import { describe, expect, it } from 'vitest';
import type { Medication } from '../../src/types';
import {
  getMedicationTreatmentEndDate,
  getMedicationTreatmentStartDate,
  isMedicationTreatmentActiveOnDate,
} from '../../src/utils/medicationTreatment';
import { getAutoDeductionSlotsForDate } from '../../src/hooks/useAutoDeductionScheduler';
import { sortMedications } from '../../src/utils/medicationSorting';

function med(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-09-22T10:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
    dosesPerDay: 1,
    ...overrides,
  };
}

describe('treatment duration scheduling', () => {
  it('uses an inclusive calendar-day boundary', () => {
    const medication = med({
      isChronic: false,
      durationDays: 5,
      treatmentStartDate: '2026-09-22',
    });

    expect(getMedicationTreatmentStartDate(medication)).toBe('2026-09-22');
    expect(getMedicationTreatmentEndDate(medication)).toBe('2026-09-26');
    expect(isMedicationTreatmentActiveOnDate(medication, '2026-09-26')).toBe(true);
    expect(isMedicationTreatmentActiveOnDate(medication, '2026-09-27')).toBe(false);
  });

  it('stops Exact Auto desired slots after the course ends', () => {
    const medication = med({
      isChronic: false,
      durationDays: 2,
      treatmentStartDate: '2026-09-22',
    });

    expect(getAutoDeductionSlotsForDate(medication, '2026-09-22')).toHaveLength(1);
    expect(getAutoDeductionSlotsForDate(medication, '2026-09-23')).toHaveLength(1);
    expect(getAutoDeductionSlotsForDate(medication, '2026-09-24')).toEqual([]);
  });

  it('treats legacy records without isChronic as chronic for duration sorting', () => {
    const legacy = med({ isChronic: undefined, durationDays: undefined });
    const course = med({
      id: 'med-2',
      isChronic: false,
      durationDays: 7,
      treatmentStartDate: '2026-09-22',
    });

    const asc = sortMedications([legacy, course], 'duration', 'asc');
    const desc = sortMedications([legacy, course], 'duration', 'desc');

    expect(asc.map((m) => m.id)).toEqual(['med-2', 'med-1']);
    expect(desc.map((m) => m.id)).toEqual(['med-1', 'med-2']);
  });
});
