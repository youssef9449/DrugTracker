import { describe, it, expect } from 'vitest';
import {
  addMedicationFormReducer,
  createDefaultFormModel,
  createEditFormModel,
} from '../../src/hooks/addMedicationFormReducer';
import type { Medication } from '../../src/types';

function baseMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'm1',
    name: 'Test',
    currentPills: 20,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    ...overrides,
  };
}

describe('addMedicationFormReducer', () => {
  it('creates default add-mode model', () => {
    const m = createDefaultFormModel(true);
    expect(m.details.name).toBe('');
    expect(m.stock.currentPills).toBe(30);
    expect(m.treatment.autoDeductEnabled).toBe(true);
    expect(m.dosage.dosesPerDay).toBe(1);
  });

  it('initializes edit mode from medication', () => {
    const m = createEditFormModel(
      baseMed({ name: 'Aspirin', currentPills: 12, isChronic: false, durationDays: 7 })
    );
    expect(m.details.name).toBe('Aspirin');
    expect(m.stock.currentPills).toBe(12);
    expect(m.treatment.isChronic).toBe(false);
    expect(m.treatment.durationDaysStr).toBe('7');
  });

  it('UNIT_CHANGED applies liquid defaults in add mode', () => {
    const start = createDefaultFormModel();
    const next = addMedicationFormReducer(start, {
      type: 'UNIT_CHANGED',
      nextUnit: 'مل',
    });
    expect(next.details.unit).toBe('مل');
    expect(next.stock.packageSize).toBe(100);
    expect(next.stock.currentPills).toBe(100);
  });

  it('UNIT_CHANGED skips defaults when skipDefaults', () => {
    const start = createDefaultFormModel();
    const next = addMedicationFormReducer(start, {
      type: 'UNIT_CHANGED',
      nextUnit: 'مل',
      skipDefaults: true,
    });
    expect(next.details.unit).toBe('مل');
    expect(next.stock.packageSize).toBe(30);
    expect(next.stock.currentPills).toBe(30);
  });

  it('STRIPS_CHANGED updates package size', () => {
    const start = createDefaultFormModel();
    const next = addMedicationFormReducer(start, {
      type: 'STRIPS_CHANGED',
      value: '4',
    });
    expect(next.packaging.stripsPerBox).toBe('4');
    expect(next.stock.packageSize).toBe(40); // 4 * 10
  });

  it('SET_ERROR updates ui.error', () => {
    const start = createDefaultFormModel();
    const next = addMedicationFormReducer(start, {
      type: 'SET_ERROR',
      value: 'fail',
    });
    expect(next.ui.error).toBe('fail');
  });

  it('SET_IS_CHRONIC clears duration when chronic', () => {
    let m = createDefaultFormModel();
    m = addMedicationFormReducer(m, { type: 'SET_IS_CHRONIC', value: false });
    m = addMedicationFormReducer(m, {
      type: 'SET_DURATION_DAYS_STR',
      value: '10',
    });
    m = addMedicationFormReducer(m, { type: 'SET_IS_CHRONIC', value: true });
    expect(m.treatment.isChronic).toBe(true);
    expect(m.treatment.durationDaysStr).toBe('');
  });
});
