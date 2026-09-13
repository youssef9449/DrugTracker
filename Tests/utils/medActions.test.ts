import { describe, it, expect } from 'vitest';
import { settleAndAdjust, consumeDose, resolveRestoreDoseAmount } from '@/utils/medActions';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('settleAndAdjust (#78)', () => {
  it('settles at the effective balance + applies a positive delta (restore)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-01' });
    const today = '2024-01-10';
    // 9 days passed at 2/day → effPills = 30 - 18 = 12. Restore +2 → 14.
    const result = settleAndAdjust(med, 2, today);
    expect(result.updatedMed.currentPills).toBe(14);
    expect(result.updatedMed.lastSyncDate).toBe(today);
    expect(result.appliedDelta).toBe(2);
  });

  it('applies a positive delta when no days passed (refill)', () => {
    const med = makeMed({ currentPills: 20, dailyDose: 1, lastSyncDate: '2024-01-10' });
    const result = settleAndAdjust(med, 15, '2024-01-10');
    // effPills = 20 (0 days passed). 20 + 15 = 35.
    expect(result.updatedMed.currentPills).toBe(35);
    expect(result.updatedMed.lastSyncDate).toBe('2024-01-10');
  });

  it('clamps at 0 when the delta would make the balance negative', () => {
    const med = makeMed({ currentPills: 5, dailyDose: 10, lastSyncDate: '2024-01-01' });
    // effPills = max(0, 5 - 10*9) → 0. -5 → 0.
    const result = settleAndAdjust(med, -5, '2024-01-10');
    expect(result.updatedMed.currentPills).toBe(0);
  });

  it('does not mutate the input medication', () => {
    const med = makeMed({ currentPills: 30 });
    const result = settleAndAdjust(med, 10, '2024-01-10');
    expect(med.currentPills).toBe(30); // unchanged
    expect(result.updatedMed).not.toBe(med);
  });

  it('respects autoDeductEnabled=false (effPills = currentPills)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-01', autoDeductEnabled: false });
    // auto-deduct off → effPills = 30 (no projection). +5 → 35.
    const result = settleAndAdjust(med, 5, '2024-01-10');
    expect(result.updatedMed.currentPills).toBe(35);
  });
});

describe('consumeDose (#77)', () => {
  it('consumes a dose from the alarm path (source: alarm)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'alarm', '2024-01-10');
    // effPills = 30 (0 days passed). dose = min(2, 30) = 2. newSnapshot = 28.
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed).not.toBeNull();
    expect(result.updatedMed!.currentPills).toBe(28);
    expect(result.updatedMed!.lastConsumedDate).toBe('2024-01-10');
    expect(result.updatedMed!.lastSyncDate).toBe('2024-01-10');
    expect(result.log).not.toBeNull();
    expect(result.log!.type).toBe('dose_taken');
    expect(result.log!.amount).toBe(-2);
    expect(result.log!.description).toContain('من التنبيه');
    // Uses generateId('consume') — not 'consume-' + Date.now() (#64).
    expect(result.log!.id).toMatch(/^consume-/);
  });

  it('consumes a dose from the manual path (source: manual)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed!.currentPills).toBe(28);
    expect(result.log!.description).toContain('يدوياً');
  });

  it('returns null (no consumption) when the effective balance is 0', () => {
    const med = makeMed({ currentPills: 0, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
    expect(result.log).toBeNull();
  });

  it('returns null when the dailyDose is 0 (no consumption rate)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 0, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
    expect(result.log).toBeNull();
  });

  it('clamps the dose to the effective balance (partial consumption)', () => {
    const med = makeMed({ currentPills: 1, dailyDose: 5, lastSyncDate: '2024-01-10' });
    // effPills = 1. dose = min(5, 1) = 1. newSnapshot = 0.
    const result = consumeDose(med, 'alarm', '2024-01-10');
    expect(result.doseAmount).toBe(1);
    expect(result.updatedMed!.currentPills).toBe(0);
  });

  it('projects the effective balance forward before consuming (app was closed for days)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-01' });
    // 9 days passed → effPills = 30 - 18 = 12. dose = min(2, 12) = 2. newSnapshot = 10.
    const result = consumeDose(med, 'manual', '2024-01-10');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed!.currentPills).toBe(10);
  });

  it('does not mutate the input medication', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    consumeDose(med, 'alarm', '2024-01-10');
    expect(med.currentPills).toBe(30);
    expect(med.lastConsumedDate).toBeUndefined();
  });

  it('uses generateId("consume") for the log id (not Date.now() — #64)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 2, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10');
    // generateId('consume') → 'consume-<uuid>' (40 chars). Not 'consume-<timestamp>'.
    expect(result.log!.id).toMatch(/^consume-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});


describe('resolveRestoreDoseAmount (multi-dose restore)', () => {
  const multi = makeMed({
    dailyDose: 4,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 2, time: '20:00' },
    ],
    dosesPerDay: 3,
  });

  it('returns dose.amount for explicit multi-dose id (not dailyDose)', () => {
    expect(resolveRestoreDoseAmount(multi, 'd1')).toEqual({
      ok: true,
      amount: 1,
      doseId: 'd1',
    });
    expect(resolveRestoreDoseAmount(multi, 'd3')).toEqual({
      ok: true,
      amount: 2,
      doseId: 'd3',
    });
  });

  it('rejects multi-dose restore without doseId', () => {
    expect(resolveRestoreDoseAmount(multi)).toEqual({
      ok: false,
      amount: 0,
      reason: 'missing_dose_id',
    });
  });

  it('rejects invalid doseId', () => {
    expect(resolveRestoreDoseAmount(multi, 'missing')).toEqual({
      ok: false,
      amount: 0,
      reason: 'invalid_dose_id',
    });
  });

  it('single-slot schedule uses that slot amount when doseId omitted', () => {
    const one = makeMed({
      dailyDose: 5,
      doseSchedule: [{ id: 'only', amount: 3, time: '09:00' }],
      dosesPerDay: 1,
    });
    expect(resolveRestoreDoseAmount(one)).toEqual({
      ok: true,
      amount: 3,
      doseId: 'only',
    });
  });

  it('legacy med uses dailyDose', () => {
    const legacy = makeMed({ dailyDose: 2, doseSchedule: undefined });
    expect(resolveRestoreDoseAmount(legacy)).toEqual({ ok: true, amount: 2 });
  });

  it('settleAndAdjust with resolved multi amount adds only that amount', () => {
    // lastSync = today so no past projection; +1 restore → currentPills + 1
    const med = makeMed({
      currentPills: 10,
      dailyDose: 4,
      lastSyncDate: '2024-09-13',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 2, time: '20:00' },
      ],
    });
    const resolved = resolveRestoreDoseAmount(med, 'd1');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const { updatedMed, appliedDelta } = settleAndAdjust(
      med,
      resolved.amount,
      '2024-09-13'
    );
    expect(appliedDelta).toBe(1);
    expect(updatedMed.currentPills).toBe(11);
  });

  it('restore of 20:00 slot adds 2 not dailyDose 4', () => {
    const med = makeMed({
      currentPills: 10,
      dailyDose: 4,
      lastSyncDate: '2024-09-13',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 2, time: '20:00' },
      ],
    });
    const resolved = resolveRestoreDoseAmount(med, 'd3');
    expect(resolved.ok && resolved.amount).toBe(2);
    if (!resolved.ok) return;
    const { updatedMed } = settleAndAdjust(med, resolved.amount, '2024-09-13');
    expect(updatedMed.currentPills).toBe(12);
  });
});

describe('consumeDose strict doseId identity', () => {
  const multi = (overrides: Partial<Medication> = {}): Medication =>
    makeMed({
      currentPills: 30,
      dailyDose: 4,
      lastSyncDate: '2024-09-13',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 2, time: '14:00' },
        { id: 'd3', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 3,
      ...overrides,
    });

  it('multi + explicit d2 consumes d2 amount and logs d2 only', () => {
    const med = multi();
    const result = consumeDose(med, 'manual', '2024-09-13', new Date('2024-09-13T15:00:00'), 'd2');
    expect(result.doseAmount).toBe(2);
    expect(result.log?.doseId).toBe('d2');
    expect(result.updatedMed?.doseConsumption?.d2).toBe('2024-09-13');
    expect(result.updatedMed?.doseConsumption?.d1).toBeUndefined();
    expect(result.updatedMed?.doseConsumption?.d3).toBeUndefined();
  });

  it('multi + missing doseId fails with missing_dose_id and mutates nothing', () => {
    const med = multi();
    const result = consumeDose(med, 'manual', '2024-09-13', new Date('2024-09-13T15:00:00'));
    expect(result.reason).toBe('missing_dose_id');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
    expect(result.log).toBeNull();
  });

  it('multi + invalid doseId fails with invalid_dose_id', () => {
    const med = multi();
    const result = consumeDose(
      med,
      'manual',
      '2024-09-13',
      new Date('2024-09-13T15:00:00'),
      'not-a-slot'
    );
    expect(result.reason).toBe('invalid_dose_id');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
  });

  it('single-slot schedule + omitted doseId resolves to that slot id and amount', () => {
    const med = makeMed({
      currentPills: 20,
      dailyDose: 4,
      lastSyncDate: '2024-09-13',
      doseSchedule: [{ id: 'only', amount: 2, time: '09:00' }],
      dosesPerDay: 1,
    });
    const result = consumeDose(med, 'manual', '2024-09-13', new Date('2024-09-13T10:00:00'));
    expect(result.doseAmount).toBe(2);
    expect(result.log?.doseId).toBe('only');
    expect(result.updatedMed?.doseConsumption?.only).toBe('2024-09-13');
  });

  it('legacy + omitted doseId uses dailyDose (unchanged)', () => {
    const med = makeMed({
      currentPills: 10,
      dailyDose: 1,
      lastSyncDate: '2024-09-13',
      doseSchedule: undefined,
      dosesPerDay: undefined,
    });
    const result = consumeDose(med, 'manual', '2024-09-13', new Date('2024-09-13T10:00:00'));
    expect(result.doseAmount).toBe(1);
    expect(result.log?.doseId).toBeUndefined();
    expect(result.updatedMed?.lastConsumedDate).toBe('2024-09-13');
  });

  it('reordering schedule does not change which doseId is consumed', () => {
    const med = multi({
      doseSchedule: [
        { id: 'd3', amount: 1, time: '20:00' },
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 2, time: '14:00' },
      ],
    });
    const result = consumeDose(med, 'manual', '2024-09-13', new Date('2024-09-13T15:00:00'), 'd2');
    expect(result.log?.doseId).toBe('d2');
    expect(result.doseAmount).toBe(2);
  });

  it('changing slot time does not change doseId identity', () => {
    const med = multi({
      doseSchedule: [
        { id: 'd1', amount: 1, time: '07:00' },
        { id: 'd2', amount: 2, time: '15:30' },
        { id: 'd3', amount: 1, time: '22:00' },
      ],
    });
    const result = consumeDose(med, 'manual', '2024-09-13', new Date('2024-09-13T16:00:00'), 'd2');
    expect(result.log?.doseId).toBe('d2');
    expect(result.doseAmount).toBe(2);
  });
});

describe('resolveRestoreDoseAmount strict doseId identity', () => {
  const multi = (overrides: Partial<Medication> = {}): Medication =>
    makeMed({
      currentPills: 20,
      dailyDose: 4,
      lastSyncDate: '2024-09-13',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 2, time: '14:00' },
        { id: 'd3', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 3,
      ...overrides,
    });

  it('multi + explicit d2 restores amount 2 only', () => {
    const resolved = resolveRestoreDoseAmount(multi(), 'd2');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.amount).toBe(2);
    expect(resolved.doseId).toBe('d2');
  });

  it('multi + missing doseId fails with missing_dose_id', () => {
    const resolved = resolveRestoreDoseAmount(multi());
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('missing_dose_id');
  });

  it('single-slot + omitted doseId resolves to the only slot', () => {
    const med = makeMed({
      doseSchedule: [{ id: 'only', amount: 3, time: '10:00' }],
      dosesPerDay: 1,
      dailyDose: 3,
    });
    const resolved = resolveRestoreDoseAmount(med);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.doseId).toBe('only');
    expect(resolved.amount).toBe(3);
  });

  it('legacy restore uses dailyDose without doseId', () => {
    const med = makeMed({ doseSchedule: undefined, dailyDose: 2 });
    const resolved = resolveRestoreDoseAmount(med);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.amount).toBe(2);
    expect(resolved.doseId).toBeUndefined();
  });
});
