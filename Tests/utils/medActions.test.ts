import { describe, it, expect } from 'vitest';
import {
  consumeDose,
  restoreDose,
  resolveRestoreDoseId,
  applyDurableStockDelta,
  findActiveDeductionForOccurrence,
  getHistoricalRestoreDisplayAmount,
  isUiAutoHistoricalRestoreEligible,
  isExactAutoDeductionEvidence,
  isUiConsumedRestoreEligible,
  findActualDeductedAmountForOccurrence } from '@/utils/medActions';
import type { Medication, ConsumptionLog } from '@/types';

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
    lastSyncDate: '2024-01-10',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    dosesPerDay: 1,
    ...overrides,
  };
}

function makeLog(overrides: Partial<ConsumptionLog> = {}): ConsumptionLog {
  return {
    id: 'log-1',
    medicationId: 'med-1',
    medicationName: 'Test',
    type: 'dose_taken',
    amount: -2,
    date: '2024-01-10',
    timestamp: '2024-01-10T08:00:00.000Z',
    description: 'test',
    ...overrides,
  };
}

// ─── applyDurableStockDelta ────────────────────────────────────────────
describe('applyDurableStockDelta (#267 — durable stock mutation)', () => {
  it('applies a positive delta (restore/refill) to currentPills', () => {
    const med = makeMed({ currentPills: 30 });
    const result = applyDurableStockDelta(med, 2);
    expect(result.currentPills).toBe(32);
  });

  it('applies a negative delta (consume) to currentPills', () => {
    const med = makeMed({ currentPills: 30 });
    const result = applyDurableStockDelta(med, -2);
    expect(result.currentPills).toBe(28);
  });

  it('clamps the result at 0 when the delta would make the balance negative', () => {
    const med = makeMed({ currentPills: 5 });
    const result = applyDurableStockDelta(med, -10);
    expect(result.currentPills).toBe(0);
  });

  it('does NOT change lastSyncDate (no settlement horizon)', () => {
    const med = makeMed({ currentPills: 30, lastSyncDate: '2024-01-01' });
    const result = applyDurableStockDelta(med, 5);
    expect(result.lastSyncDate).toBe('2024-01-01');
  });

  it('does NOT mutate the input medication', () => {
    const med = makeMed({ currentPills: 30 });
    const result = applyDurableStockDelta(med, 10);
    expect(med.currentPills).toBe(30); // unchanged
    expect(result).not.toBe(med);
  });

  it('treats a negative currentPills as 0 base (defensive clamp)', () => {
    const med = makeMed({ currentPills: -5 } as unknown as Medication);
    const result = applyDurableStockDelta(med, 10);
    // base = max(0, -5) = 0; +10 = 10
    expect(result.currentPills).toBe(10);
  });
});

// ─── consumeDose (#267 contract) ──────────────────────────────────────
describe('consumeDose (#267 — durable deduction, no settlement)', () => {
  it('consumes a dose from the alarm path (source: alarm)', () => {
    const med = makeMed({ currentPills: 30, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'alarm', '2024-01-10', new Date('2024-01-10T08:00:00'), 'd1');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed).not.toBeNull();
    expect(result.updatedMed!.currentPills).toBe(28);
    expect(result.updatedMed!.lastConsumedDate).toBe('2024-01-10');
    // Issue #267: lastSyncDate is NOT changed by consume.
    expect(result.updatedMed!.lastSyncDate).toBe('2024-01-10');
    expect(result.log).not.toBeNull();
    expect(result.log!.type).toBe('dose_taken');
    expect(result.log!.amount).toBe(-2);
    expect(result.log!.description).toContain('من التنبيه');
    expect(result.log!.doseId).toBe('d1');
  });

  it('consumes a dose from the manual path (source: manual)', () => {
    const med = makeMed({ currentPills: 30, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10', new Date('2024-01-10T08:00:00'), 'd1');
    expect(result.doseAmount).toBe(2);
    expect(result.updatedMed!.currentPills).toBe(28);
    expect(result.log!.description).toContain('يدوياً');
  });

  it('returns null when the durable balance is 0', () => {
    const med = makeMed({ currentPills: 0, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10', new Date('2024-01-10T08:00:00'), 'd1');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
    expect(result.log).toBeNull();
  });

  it('clamps the dose to the durable balance (partial consumption)', () => {
    const med = makeMed({
      currentPills: 1,
      lastSyncDate: '2024-01-10',
      doseSchedule: [{ id: 'd1', amount: 5, time: '08:00' }],
    });
    // settleBase = max(0, 1) = 1. dose = min(5, 1) = 1. newSnapshot = 0.
    const result = consumeDose(med, 'alarm', '2024-01-10', new Date('2024-01-10T08:00:00'), 'd1');
    expect(result.doseAmount).toBe(1);
    expect(result.updatedMed!.currentPills).toBe(0);
  });

  it('does NOT project forward from lastSyncDate before consuming (no historical catch-up)', () => {
    // Issue #267: app closed for days. The OLD behavior deducted
    // daysPassed*dailyDose from the effective balance before the consume.
    // The NEW behavior deducts from durable currentPills only — no
    // historical catch-up, no effective balance, no lastSyncDate change.
    const med = makeMed({
      currentPills: 30,
      dailyDose: 2,
      lastSyncDate: '2024-01-01', // 9 days passed
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const result = consumeDose(med, 'manual', '2024-01-10', new Date('2024-01-10T08:00:00'), 'd1');
    expect(result.doseAmount).toBe(2);
    // 30 - 2 = 28 (NOT 30 - 9*2 - 2 = 10).
    expect(result.updatedMed!.currentPills).toBe(28);
    // lastSyncDate is NOT bumped.
    expect(result.updatedMed!.lastSyncDate).toBe('2024-01-01');
  });

  it('does not mutate the input medication', () => {
    const med = makeMed({ currentPills: 30, lastSyncDate: '2024-01-10' });
    consumeDose(med, 'alarm', '2024-01-10', new Date('2024-01-10T08:00:00'), 'd1');
    expect(med.currentPills).toBe(30);
    expect(med.lastConsumedDate).toBeUndefined();
  });

  it('uses generateId("consume") for the log id (not Date.now() — #64)', () => {
    const med = makeMed({ currentPills: 30, lastSyncDate: '2024-01-10' });
    const result = consumeDose(med, 'manual', '2024-01-10', new Date('2024-01-10T08:00:00'), 'd1');
    // generateId('consume') → 'consume-<uuid>' (40 chars). Not 'consume-<timestamp>'.
    expect(result.log!.id).toMatch(/^consume-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ─── consumeDose strict doseId identity (#267 — no Legacy fallback) ──
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

// ─── consumeDose no-schedule rejection (#267/#268 — no Legacy fallback) ─
describe('consumeDose rejects no-schedule meds (#267/#268)', () => {
  it('rejects a no-schedule med with missing_dose_id when doseId is omitted', () => {
    const med = makeMed({
      doseSchedule: undefined,
      dosesPerDay: undefined,
      dailyDose: 2,
    });
    const result = consumeDose(med, 'manual', '2024-01-10', new Date('2024-01-10T08:00:00'));
    expect(result.reason).toBe('missing_dose_id');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
    expect(result.log).toBeNull();
  });

  it('rejects a no-schedule med with invalid_dose_id when an explicit doseId is given', () => {
    const med = makeMed({
      doseSchedule: undefined,
      dosesPerDay: undefined,
      dailyDose: 2,
    });
    const result = consumeDose(
      med,
      'manual',
      '2024-01-10',
      new Date('2024-01-10T08:00:00'),
      'legacy'
    );
    expect(result.reason).toBe('invalid_dose_id');
    expect(result.doseAmount).toBe(0);
    expect(result.updatedMed).toBeNull();
  });

  it('rejects a no-schedule med even when dailyDose > 0 (no dailyDose fallback)', () => {
    const med = makeMed({
      doseSchedule: [],
      dosesPerDay: 0,
      dailyDose: 5,
    });
    const result = consumeDose(med, 'manual', '2024-01-10', new Date('2024-01-10T08:00:00'));
    expect(result.reason).toBe('missing_dose_id');
    expect(result.doseAmount).toBe(0);
  });
});

// ─── resolveRestoreDoseId (identity only — amount comes from log) ─────
describe('resolveRestoreDoseId (identity only — #267)', () => {
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

  it('multi + explicit d2 resolves to d2', () => {
    const resolved = resolveRestoreDoseId(multi(), 'd2');
    expect(resolved).toEqual({ ok: true, doseId: 'd2' });
  });

  it('multi + missing doseId fails with missing_dose_id', () => {
    const resolved = resolveRestoreDoseId(multi());
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('missing_dose_id');
  });

  it('multi + invalid doseId fails with invalid_dose_id', () => {
    const resolved = resolveRestoreDoseId(multi(), 'not-a-slot');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('invalid_dose_id');
  });

  it('single-slot + omitted doseId resolves to the only slot', () => {
    const med = makeMed({
      doseSchedule: [{ id: 'only', amount: 3, time: '10:00' }],
      dosesPerDay: 1,
      dailyDose: 3,
    });
    const resolved = resolveRestoreDoseId(med);
    expect(resolved).toEqual({ ok: true, doseId: 'only' });
  });

  it('no-schedule med rejects with no_dose when doseId is omitted', () => {
    const med = makeMed({ doseSchedule: undefined, dosesPerDay: undefined });
    const resolved = resolveRestoreDoseId(med);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('no_dose');
  });

  it('no-schedule med rejects with invalid_dose_id when an explicit doseId is given', () => {
    const med = makeMed({ doseSchedule: undefined, dosesPerDay: undefined });
    const resolved = resolveRestoreDoseId(med, 'legacy');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('invalid_dose_id');
  });
});

// ─── restoreDose (#267 — requires durable deduction evidence) ─────────
describe('restoreDose (#267 — durable deduction evidence)', () => {
  const today = '2024-01-10';
  const now = new Date('2024-01-10T20:00:00');

  it('restores the active deduction log amount (Manual Take)', () => {
    const med = makeMed({
      currentPills: 28, // 30 - 2 (after manual Take of d1=2)
      lastSyncDate: '2024-01-10',
      doseConsumption: { d1: today },
      doseConsumptionHistory: { d1: [today] },
    });
    const logs: ConsumptionLog[] = [
      makeLog({ id: 'take-1', type: 'dose_taken', amount: -2, doseId: 'd1', date: today }),
    ];
    const result = restoreDose(med, 'd1', today, now, logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredAmount).toBe(2);
    expect(result.updatedMed.currentPills).toBe(30); // 28 + 2
    expect(result.doseId).toBe('d1');
    expect(result.wasActuallyConsumed).toBe(true);
    expect(result.reversedLogId).toBe('take-1');
  });

  it('restores the active deduction log amount (Auto Daily)', () => {
    const med = makeMed({
      currentPills: 28,
      lastSyncDate: '2024-01-10',
      doseConsumption: { d1: today },
      doseConsumptionHistory: { d1: [today] },
    });
    const logs: ConsumptionLog[] = [
      makeLog({ id: `exact-auto:med-1:d1:${today}`, type: 'exact_auto', amount: -2, doseId: 'd1', date: today }),
    ];
    const result = restoreDose(med, 'd1', today, now, logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredAmount).toBe(2);
    expect(result.updatedMed.currentPills).toBe(30);
  });

  it('rejects with missing_deduction_evidence when no active deduction log exists', () => {
    // Pure-projection Restore is GONE (#267): elapsed time without a durable
    // deduction log does NOT add stock.
    const med = makeMed({
      currentPills: 30,
      lastSyncDate: '2024-01-01', // 9 days passed
    });
    const result = restoreDose(med, 'd1', '2024-01-10', now, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_deduction_evidence');
  });

  it('rejects with already_restored when the consume marker exists but the deduction is reversed', () => {
    const med = makeMed({
      currentPills: 30,
      lastSyncDate: '2024-01-10',
      doseConsumption: { d1: today },
      doseConsumptionHistory: { d1: [today] },
    });
    // The deduction log exists but is already reversed.
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'take-1',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: today,
        reversedAt: '2024-01-10T19:00:00.000Z',
      }),
    ];
    const result = restoreDose(med, 'd1', today, now, logs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_restored');
  });

  it('rejects with missing_dose_id when multi-dose and no doseId is given', () => {
    const med = makeMed({
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 2, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const result = restoreDose(med, undefined, today, now, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_dose_id');
  });

  it('does NOT change lastSyncDate (no settlement horizon)', () => {
    const med = makeMed({
      currentPills: 28,
      lastSyncDate: '2024-01-01', // 9 days passed
      doseConsumption: { d1: today },
      doseConsumptionHistory: { d1: [today] },
    });
    const logs: ConsumptionLog[] = [
      makeLog({ id: 'take-1', type: 'dose_taken', amount: -2, doseId: 'd1', date: today }),
    ];
    const result = restoreDose(med, 'd1', today, now, logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedMed.lastSyncDate).toBe('2024-01-01'); // unchanged
  });

  it('restores from the historical deduction log amount, not the current schedule amount', () => {
    // The schedule was 2 when the Take happened; later the user edits the
    // schedule to 5. Restore must use the historical 2, not the current 5.
    const med = makeMed({
      currentPills: 28,
      lastSyncDate: '2024-01-10',
      doseConsumption: { d1: today },
      doseConsumptionHistory: { d1: [today] },
      doseSchedule: [{ id: 'd1', amount: 5, time: '08:00' }], // edited from 2
    });
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'take-1',
        type: 'dose_taken',
        amount: -2, // historical amount at the time of Take
        doseId: 'd1',
        date: today,
      }),
    ];
    const result = restoreDose(med, 'd1', today, now, logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Restored amount = abs(log.amount) = 2, NOT the current schedule amount 5.
    expect(result.restoredAmount).toBe(2);
    expect(result.updatedMed.currentPills).toBe(30); // 28 + 2
  });
});

// ─── findActiveDeductionForOccurrence ─────────────────────────────────
describe('findActiveDeductionForOccurrence', () => {
  const today = '2024-01-10';

  it('finds the active (un-reversed) dose_taken deduction for the occurrence', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'take-1',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: today,
        timestamp: '2024-01-10T08:00:00.000Z',
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result?.id).toBe('take-1');
  });

  it('skips reversed deductions (finds the next active one)', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'take-1',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: today,
        timestamp: '2024-01-10T08:00:00.000Z',
        reversedAt: '2024-01-10T19:00:00.000Z',
      }),
      makeLog({
        id: 'take-2',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: today,
        timestamp: '2024-01-10T20:00:00.000Z',
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result?.id).toBe('take-2');
  });

  it('returns null when no active deduction exists', () => {
    const logs: ConsumptionLog[] = [];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result).toBeNull();
  });

  it('returns null for a different medicationId', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'take-1',
        medicationId: 'other-med',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: today,
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result).toBeNull();
  });

  it('returns null for a different date', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'take-1',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: '2024-01-09',
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result).toBeNull();
  });

  it('returns null for a different doseId', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'take-1',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd2',
        date: today,
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result).toBeNull();
  });

  it('selects the most-recent active deduction by timestamp (deterministic)', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'older',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: today,
        timestamp: '2024-01-10T08:00:00.000Z',
      }),
      makeLog({
        id: 'newer',
        type: 'dose_taken',
        amount: -2,
        doseId: 'd1',
        date: today,
        timestamp: '2024-01-10T20:00:00.000Z',
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result?.id).toBe('newer');
  });

  it('accepts exact_auto logs as well as dose_taken', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: `exact-auto:med-1:d1:${today}`,
        type: 'exact_auto',
        amount: -2,
        doseId: 'd1',
        date: today,
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result?.id).toBe(`exact-auto:med-1:d1:${today}`);
  });

  it('accepts legacy auto_daily only when id is deterministic Exact occurrence id', () => {
    const exactId = `exact-auto:med-1:d1:${today}`;
    const logs: ConsumptionLog[] = [
      makeLog({
        id: exactId,
        type: 'auto_daily',
        amount: -2,
        doseId: 'd1',
        date: today,
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result?.id).toBe(exactId);
  });

  it('rejects ordinary legacy auto_daily without deterministic Exact id', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'log-init-1',
        type: 'auto_daily',
        amount: -2,
        doseId: 'd1',
        date: today,
      }),
    ];
    const result = findActiveDeductionForOccurrence(logs, 'med-1', 'd1', today);
    expect(result).toBeNull();
  });

  // Issue #276 — Exact Auto evidence requires deterministic occurrence id
  it('Case A: exact_auto with arbitrary id is NOT evidence and not selected', () => {
    const bad = makeLog({
      id: 'random-id',
      type: 'exact_auto',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    expect(isExactAutoDeductionEvidence(bad, 'med-1', 'd1', today)).toBe(false);
    expect(
      findActiveDeductionForOccurrence([bad], 'med-1', 'd1', today)
    ).toBeNull();
  });

  it('Case B: exact_auto for a different doseId occurrence is not selected for d1', () => {
    const otherDose = makeLog({
      id: `exact-auto:med-1:d2:${today}`,
      type: 'exact_auto',
      amount: -2,
      doseId: 'd2',
      date: today,
    });
    expect(
      isExactAutoDeductionEvidence(otherDose, 'med-1', 'd1', today)
    ).toBe(false);
    expect(
      findActiveDeductionForOccurrence([otherDose], 'med-1', 'd1', today)
    ).toBeNull();
  });

  it('Case C: valid current exact_auto with deterministic id is accepted', () => {
    const exactId = `exact-auto:med-1:d1:${today}`;
    const good = makeLog({
      id: exactId,
      type: 'exact_auto',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    expect(isExactAutoDeductionEvidence(good, 'med-1', 'd1', today)).toBe(true);
    expect(
      findActiveDeductionForOccurrence([good], 'med-1', 'd1', today)?.id
    ).toBe(exactId);
  });

  it('Case D: valid legacy auto_daily with deterministic Exact id remains readable', () => {
    const exactId = `exact-auto:med-1:d1:${today}`;
    const legacy = makeLog({
      id: exactId,
      type: 'auto_daily',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    expect(isExactAutoDeductionEvidence(legacy, 'med-1', 'd1', today)).toBe(true);
    expect(
      findActiveDeductionForOccurrence([legacy], 'med-1', 'd1', today)?.id
    ).toBe(exactId);
  });

  it('Case E: ordinary auto_daily is rejected as Exact Auto evidence', () => {
    const ordinary = makeLog({
      id: 'log-init-1',
      type: 'auto_daily',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    expect(
      isExactAutoDeductionEvidence(ordinary, 'med-1', 'd1', today)
    ).toBe(false);
    expect(
      findActiveDeductionForOccurrence([ordinary], 'med-1', 'd1', today)
    ).toBeNull();
  });
});

// ─── UI helpers (historical restore eligibility / display amount) ────
describe('getHistoricalRestoreDisplayAmount / eligibility helpers', () => {
  const today = '2024-01-10';

  it('getHistoricalRestoreDisplayAmount returns abs(log.amount) for an active deduction', () => {
    const logs: ConsumptionLog[] = [
      makeLog({ id: 'take-1', type: 'dose_taken', amount: -3, doseId: 'd1', date: today }),
    ];
    expect(getHistoricalRestoreDisplayAmount(logs, 'med-1', 'd1', today)).toBe(3);
  });

  it('getHistoricalRestoreDisplayAmount returns null when no active deduction exists', () => {
    expect(getHistoricalRestoreDisplayAmount([], 'med-1', 'd1', today)).toBeNull();
  });

  it('findActualDeductedAmountForOccurrence returns the active deduction amount', () => {
    const logs: ConsumptionLog[] = [
      makeLog({ id: 'take-1', type: 'dose_taken', amount: -4, doseId: 'd1', date: today }),
    ];
    expect(findActualDeductedAmountForOccurrence(logs, 'med-1', 'd1', today)).toBe(4);
  });

  it('isUiAutoHistoricalRestoreEligible requires Exact Auto evidence and historical amount', () => {
    const exactLog = makeLog({
      id: `exact-auto:med-1:d1:${today}`,
      type: 'exact_auto',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    const malformedExact = makeLog({
      id: 'random-id',
      type: 'exact_auto',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    const doseTaken = makeLog({
      id: 'take-1',
      type: 'dose_taken',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    const ordinaryAuto = makeLog({
      id: 'log-init-1',
      type: 'auto_daily',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    const legacyExact = makeLog({
      id: `exact-auto:med-1:d1:${today}`,
      type: 'auto_daily',
      amount: -2,
      doseId: 'd1',
      date: today,
    });
    // valid exact_auto + amount → eligible
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, exactLog, 2, 'med-1', 'd1', today)
    ).toBe(true);
    // malformed exact_auto + amount → NOT eligible
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, malformedExact, 2, 'med-1', 'd1', today)
    ).toBe(false);
    // dose_taken is not Auto historical path
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, doseTaken, 2, 'med-1', 'd1', today)
    ).toBe(false);
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, exactLog, null, 'med-1', 'd1', today)
    ).toBe(false);
    expect(
      isUiAutoHistoricalRestoreEligible(false, false, exactLog, 2, 'med-1', 'd1', today)
    ).toBe(false);
    expect(
      isUiAutoHistoricalRestoreEligible(true, true, exactLog, 2, 'med-1', 'd1', today)
    ).toBe(false);
    // ordinary auto_daily → NOT eligible
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, ordinaryAuto, 2, 'med-1', 'd1', today)
    ).toBe(false);
    // valid legacy deterministic auto_daily → eligible
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, legacyExact, 2, 'med-1', 'd1', today)
    ).toBe(true);
  });

  it('isUiConsumedRestoreEligible requires consumed + historical amount', () => {
    expect(isUiConsumedRestoreEligible(true, false, 2)).toBe(true);
    expect(isUiConsumedRestoreEligible(true, false, null)).toBe(false);
    expect(isUiConsumedRestoreEligible(false, false, 2)).toBe(false);
    expect(isUiConsumedRestoreEligible(true, true, 2)).toBe(false);
  });
});
