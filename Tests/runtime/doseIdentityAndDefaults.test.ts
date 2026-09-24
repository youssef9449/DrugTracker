import { describe, expect, it } from 'vitest';
import type { Medication } from '@/types';
import { resolveDoseId, validateMedicationDose, normalizeDoseId } from '@/utils/doseIdentity';
import { isMedicationAutoDeductActive } from '@/utils/doseSchedule';
import {
  getAutoDeductionDefinition,
  medicationIdsWithoutAutoSchedule,
} from '@/utils/autoDeductionDefinition';

function singleDoseMed(): Medication {
  return {
    id: 'med-1',
    name: 'Med',
    currentPills: 20,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: '#000000',
    createdAt: '2026-01-01T00:00:00.000Z',
    doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
  };
}

function multiDoseMed(): Medication {
  return {
    ...singleDoseMed(),
    doseSchedule: [
      { id: 'd1', amount: 1, time: '09:00' },
      { id: 'd2', amount: 2, time: '21:00' },
    ],
  };
}

describe('canonical dose identity (#517) and resolution (#510)', () => {
  it('trims whitespace into ONE canonical identity', () => {
    expect(normalizeDoseId('  d1  ')).toBe('d1');
    expect(normalizeDoseId('   ')).toBeNull();
    expect(normalizeDoseId(undefined)).toBeNull();
  });

  it('single-dose: omitted doseId resolves to the slot id', () => {
    expect(resolveDoseId(singleDoseMed(), undefined)).toEqual({ ok: true, doseId: 'd1' });
  });

  it('multi-dose: omitted doseId is missing_dose_id', () => {
    expect(resolveDoseId(multiDoseMed(), undefined)).toEqual({
      ok: false,
      reason: 'missing_dose_id',
    });
  });

  it('explicit invalid doseId is invalid_dose_id (single and multi)', () => {
    expect(resolveDoseId(singleDoseMed(), 'not-a-slot')).toEqual({
      ok: false,
      reason: 'invalid_dose_id',
    });
    expect(resolveDoseId(multiDoseMed(), 'nope')).toEqual({
      ok: false,
      reason: 'invalid_dose_id',
    });
  });

  it('explicit valid doseId resolves canonically (whitespace-insensitive)', () => {
    expect(resolveDoseId(multiDoseMed(), ' d2 ')).toEqual({ ok: true, doseId: 'd2' });
  });

  it('no schedule: omitted → no_dose; explicit → invalid_dose_id', () => {
    const med = { ...singleDoseMed(), doseSchedule: undefined };
    expect(resolveDoseId(med, undefined)).toEqual({ ok: false, reason: 'no_dose' });
    expect(resolveDoseId(med, 'd1')).toEqual({ ok: false, reason: 'invalid_dose_id' });
  });
});

describe('canonical dose-row validation (#531)', () => {
  it('accepts a valid row and normalizes time + id', () => {
    const result = validateMedicationDose({ id: ' x1 ', amount: 1, time: '9:05' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dose).toEqual({ id: 'x1', amount: 1, time: '09:05' });
    }
  });

  it('fails closed on blank id, bad time, or non-positive amount', () => {
    expect(validateMedicationDose({ id: '  ', amount: 1, time: '09:00' }).ok).toBe(false);
    expect(validateMedicationDose({ id: 'a', amount: 1, time: '25:00' }).ok).toBe(false);
    expect(validateMedicationDose({ id: 'a', amount: 0, time: '09:00' }).ok).toBe(false);
    expect(validateMedicationDose({ id: 'a', amount: -1, time: '09:00' }).ok).toBe(false);
    expect(validateMedicationDose(null).ok).toBe(false);
  });
});

describe('missing autoDeductEnabled defaults ON (#499)', () => {
  it('medication-level policy helper', () => {
    expect(isMedicationAutoDeductActive({ ...singleDoseMed(), autoDeductEnabled: undefined })).toBe(true);
    expect(isMedicationAutoDeductActive(singleDoseMed())).toBe(true);
    expect(
      isMedicationAutoDeductActive({ ...singleDoseMed(), autoDeductEnabled: false })
    ).toBe(false);
    expect(
      isMedicationAutoDeductActive({ ...singleDoseMed(), autoDeductEnabled: true })
    ).toBe(true);
  });

  it('definition path consumes the same policy', () => {
    const med = singleDoseMed();
    delete (med as Partial<Medication>).autoDeductEnabled;
    expect(getAutoDeductionDefinition(med).enabled).toBe(true);
  });

  it('explicit false stays OFF in the definition', () => {
    expect(
      getAutoDeductionDefinition({ ...singleDoseMed(), autoDeductEnabled: false }).enabled
    ).toBe(false);
  });
});

describe('missing doseSchedule is an explicit unsupported state (#502)', () => {
  it('definition marks scheduleMissing and produces zero occurrences', () => {
    const med = { ...singleDoseMed(), doseSchedule: undefined };
    const definition = getAutoDeductionDefinition(med);
    expect(definition.scheduleMissing).toBe(true);
    expect(definition.doses).toEqual([]);
  });

  it('all-invalid rows also count as scheduleMissing', () => {
    const med = {
      ...singleDoseMed(),
      doseSchedule: [{ id: ' ', amount: 1, time: '09:00' }],
    };
    expect(getAutoDeductionDefinition(med).scheduleMissing).toBe(true);
  });

  it('multi-dose schedules are unaffected', () => {
    const definition = getAutoDeductionDefinition(multiDoseMed());
    expect(definition.scheduleMissing).toBe(false);
    expect(definition.doses).toHaveLength(2);
  });

  it('surface helper lists only auto-enabled meds without a schedule', () => {
    const missing = { ...singleDoseMed(), id: 'med-missing', doseSchedule: undefined };
    const off = {
      ...singleDoseMed(),
      id: 'med-off',
      autoDeductEnabled: false,
      doseSchedule: undefined,
    };
    const healthy = multiDoseMed();
    expect(medicationIdsWithoutAutoSchedule([missing, off, healthy])).toEqual(['med-missing']);
  });
});
