import { describe, expect, it } from 'vitest';
import {
  resolveDoseId,
  validateMedicationDose,
  normalizeDoseId,
} from '@/utils/doseIdentity';
import {
  consumeDose,
  restoreDose,
  resolveRestoreDoseId,
} from '@/utils/medActions';
import type { ConsumptionLog, Medication } from '@/types';

function single(): Medication {
  return {
    id: 'med-1',
    name: 'Med',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: '#000000',
    createdAt: '2026-01-01T00:00:00.000Z',
    doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
  };
}

function multi(): Medication {
  return {
    ...single(),
    doseSchedule: [
      { id: 'd1', amount: 1, time: '09:00' },
      { id: 'd2', amount: 2, time: '21:00' },
    ],
  };
}

const TODAY = '2026-09-13';

describe('Take resolves and consumes the canonical dose identity (#510/#515/#517)', () => {
  it('single-dose Take with omitted doseId consumes slot d1', () => {
    const result = consumeDose(single(), 'manual', TODAY, new Date(), undefined);
    expect(result.updatedMed).not.toBeNull();
    expect(result.log?.doseId).toBe('d1');
  });

  it('explicit multi-dose Take consumes only that slot', () => {
    const result = consumeDose(multi(), 'manual', TODAY, new Date(), 'd2');
    expect(result.log?.doseId).toBe('d2');
    expect(result.doseAmount).toBe(2);
  });

  it('whitespace variants are ONE identity (#517)', () => {
    const result = consumeDose(multi(), 'manual', TODAY, new Date(), ' d2 ');
    expect(result.log?.doseId).toBe('d2');
  });

  it('invalid explicit id rejects without mutation', () => {
    const result = consumeDose(multi(), 'manual', TODAY, new Date(), 'nope');
    expect(result.updatedMed).toBeNull();
    expect(result.reason).toBe('invalid_dose_id');
  });
});

describe('Restore carries the canonical identity end-to-end (#516)', () => {
  it('resolveRestoreDoseId resolves omitted single-dose to slot id', () => {
    expect(resolveRestoreDoseId(single(), undefined)).toEqual({ ok: true, doseId: 'd1' });
  });

  it('repeated Restore with no active deduction fails closed using the RESOLVED id (#516)', () => {
    const med = single();
    const consumed = consumeDose(med, 'manual', TODAY, new Date(), undefined);
    expect(consumed.updatedMed).not.toBeNull();
    const log: ConsumptionLog = consumed.log as ConsumptionLog;
    const first = restoreDose(consumed.updatedMed as Medication, undefined, TODAY, new Date(), [log]);
    expect(first.ok).toBe(true);
    // The caller persists the first Restore's reversal on the deduction log
    // (reversedAt). Second Restore: no active deduction remains and the
    // occurrence was resolved under the canonical id → fail closed with no
    // double restore.
    const second = restoreDose(
      first.ok ? first.updatedMed : med,
      undefined,
      TODAY,
      new Date(),
      [{ ...log, reversedAt: 'x' }]
    );
    expect(second.ok).toBe(false);
    expect(second.ok ? '' : second.reason).toBe('missing_deduction_evidence');
    // No stock was added twice by the repeated Restore.
    expect(first.ok && first.updatedMed.currentPills).toBe(10);
  });
});

describe('canonical validation gates invalid rows out of identity paths (#531)', () => {
  it('blank ids are rejected before resolution', () => {
    expect(normalizeDoseId('   ')).toBeNull();
    expect(validateMedicationDose({ id: ' ', amount: 1, time: '09:00' }).ok).toBe(false);
    const med = { ...single(), doseSchedule: [{ id: '  ', amount: 1, time: '09:00' }] };
    expect(resolveDoseId(med, undefined)).toEqual({ ok: false, reason: 'invalid_dose_id' });
  });
});
