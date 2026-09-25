import { describe, expect, it } from 'vitest';
import type { Medication } from '@/types';
import {
  getAutoDeductionDefinition,
  getAutoDeductionDefinitionForDate,
  medicationIdsWithoutAutoSchedule,
} from '@/utils/autoDeductionDefinition';
import { isMedicationAutoDeductActive } from '@/utils/doseSchedule';

/**
 * #502 regression coverage: missing/empty/entirely-invalid doseSchedule is
 * an explicit UNSUPPORTED runtime state for Auto-Deduction — never a silent
 * healthy-looking zero-occurrence schedule. The canonical Auto definition
 * is the sole source of truth (no hidden dailyDose/reminderTime fallbacks,
 * no synthesized dose IDs).
 */

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Med',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    doseSchedule: [
      { id: 'dose-1', amount: 1, time: '09:00' },
      { id: 'dose-2', amount: 1, time: '21:00' },
    ],
    ...overrides,
  };
}

describe('#502 Auto-Deduction schedule-missing runtime state', () => {
  it('valid schedule → normal Auto occurrences and NOT missing', () => {
    const med = makeMed({ autoDeductEnabled: true });
    const definition = getAutoDeductionDefinition(med);
    expect(definition.enabled).toBe(true);
    expect(definition.scheduleMissing).toBe(false);
    expect(definition.doses.map((d) => d.id)).toEqual(['dose-1', 'dose-2']);
    expect(medicationIdsWithoutAutoSchedule([med])).toEqual([]);
    // Future occurrences ARE generated for a valid schedule.
    expect(
      getAutoDeductionDefinitionForDate(med, '2026-03-10')
    ).toHaveLength(2);
  });

  it('OMITTED doseSchedule with Auto enabled → explicit unsupported state, no hidden occurrence', () => {
    const med = makeMed({ autoDeductEnabled: true });
    delete (med as Partial<Medication>).doseSchedule;
    const definition = getAutoDeductionDefinition(med);
    expect(definition.enabled).toBe(true);
    expect(definition.scheduleMissing).toBe(true);
    expect(definition.doses).toEqual([]);
    expect(medicationIdsWithoutAutoSchedule([med])).toEqual(['med-1']);
    // NO hidden occurrence is generated (no dailyDose fallback).
    expect(getAutoDeductionDefinitionForDate(med, '2026-03-10')).toEqual([]);
  });

  it('EMPTY doseSchedule with Auto enabled → explicit unsupported state', () => {
    const med = makeMed({ autoDeductEnabled: true, doseSchedule: [] });
    expect(getAutoDeductionDefinition(med).scheduleMissing).toBe(true);
    expect(medicationIdsWithoutAutoSchedule([med])).toEqual(['med-1']);
    expect(getAutoDeductionDefinitionForDate(med, '2026-03-10')).toEqual([]);
  });

  it('ENTIRELY-INVALID doseSchedule rows → explicit unsupported state', () => {
    const med = makeMed({
      autoDeductEnabled: true,
      doseSchedule: [
        { id: '', amount: 0, time: '99:99' },
      ] as Medication['doseSchedule'],
    });
    expect(getAutoDeductionDefinition(med).scheduleMissing).toBe(true);
    expect(medicationIdsWithoutAutoSchedule([med])).toEqual(['med-1']);
  });

  it('explicit autoDeductEnabled:false remains OFF (no unsupported-state noise)', () => {
    const med = makeMed({ autoDeductEnabled: false, doseSchedule: [] });
    expect(isMedicationAutoDeductActive(med)).toBe(false);
    // Auto disabled → not part of the missing-schedule surface.
    expect(medicationIdsWithoutAutoSchedule([med])).toEqual([]);
    expect(getAutoDeductionDefinitionForDate(med, '2026-03-10')).toEqual([]);
  });

  it('omitted autoDeductEnabled uses the documented ON default (#499)', () => {
    const med = makeMed({}); // no autoDeductEnabled field
    expect(isMedicationAutoDeductActive(med)).toBe(true);
    expect(getAutoDeductionDefinition(med).enabled).toBe(true);
    // With a valid schedule this is a normal enabled medication...
    expect(medicationIdsWithoutAutoSchedule([med])).toEqual([]);
    // ...and with no schedule it surfaces the explicit unsupported state.
    delete (med as Partial<Medication>).doseSchedule;
    expect(medicationIdsWithoutAutoSchedule([med])).toEqual(['med-1']);
  });

  it('separates enabled states: valid vs missing vs disabled are distinguishable', () => {
    const valid = makeMed({ autoDeductEnabled: true });
    const missing = makeMed({ autoDeductEnabled: true, doseSchedule: [] });
    const disabled = makeMed({ autoDeductEnabled: false, doseSchedule: [] });
    const meds = [valid, missing, disabled];

    const missingIds = medicationIdsWithoutAutoSchedule(meds);
    expect(missingIds).toEqual(['med-1']);
    // All three share the id, so the surface is computed per-medication:
    expect(getAutoDeductionDefinition(valid).scheduleMissing).toBe(false);
    expect(getAutoDeductionDefinition(missing).scheduleMissing).toBe(true);
    // Disabled meds are excluded from the missing-schedule surface even
    // when their schedule is missing — Auto is OFF for them by definition.
    expect(
      medicationIdsWithoutAutoSchedule([
        { ...disabled, id: 'med-disabled' },
      ])
    ).toEqual([]);
  });
});
