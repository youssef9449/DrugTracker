import { describe, it, expect } from 'vitest';
import { restoreDose } from '@/utils/medActions';
import type { ConsumptionLog, Medication } from '@/types';
import { exactAutoLogId } from '@/utils/autoDeductionReconciliation';

const TODAY = '2026-09-14';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 20,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', time: '08:00', amount: 2 },
      { id: 'd2', time: '14:00', amount: 1 },
    ],
    doseConsumptionHistory: {},
    ...overrides,
  };
}

describe('restoreDose durable amount authority (Phase 4)', () => {
  it('exact Auto amount wins over current schedule after schedule edit', () => {
    const med = makeMed({
      doseSchedule: [
        { id: 'd1', time: '08:00', amount: 5 }, // schedule later changed to 5
        { id: 'd2', time: '14:00', amount: 1 },
      ],
      // d1 was consumed (Exact Auto path sets consume mark when reconciled)
      doseConsumptionHistory: { d1: [TODAY] },
      currentPills: 18, // 20 - 2 historical auto
    });
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med-1', 'd1', TODAY),
        medicationId: 'med-1',
        doseId: 'd1',
        amount: -2,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
      {
        id: 'manual-d2',
        medicationId: 'med-1',
        doseId: 'd2',
        amount: -1,
        type: 'dose_taken',
        timestamp: '2026-09-14T14:00:00.000Z',
        date: TODAY,
      },
    ];
    const now = new Date('2026-09-14T15:00:00');
    const result = restoreDose(med, 'd1', TODAY, now, logs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wasActuallyConsumed).toBe(true);
    expect(result.restoredAmount).toBe(2);
    expect(result.doseId).toBe('d1');
    expect(result.reversedLogId).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(result.updatedMed.currentPills).toBe(20); // +2 only
  });

  it('sibling isolation: Restore d1 never uses d2 amount', () => {
    const med = makeMed({
      doseConsumptionHistory: { d1: [TODAY], d2: [TODAY] },
      currentPills: 17,
    });
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med-1', 'd1', TODAY),
        medicationId: 'med-1',
        doseId: 'd1',
        amount: -2,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
      {
        id: 'manual-d2',
        medicationId: 'med-1',
        doseId: 'd2',
        amount: -1,
        type: 'dose_taken',
        timestamp: '2026-09-14T14:00:00.000Z',
        date: TODAY,
      },
    ];
    const result = restoreDose(
      med,
      'd1',
      TODAY,
      new Date('2026-09-14T15:00:00'),
      logs
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredAmount).toBe(2);
    expect(result.reversedLogId).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(result.reversedLogId).not.toBe('manual-d2');
  });

  it('Auto → Restore → Take → Restore reverses the NEW Take, not the old auto', () => {
    const med = makeMed({
      doseConsumptionHistory: { d1: [TODAY] },
      currentPills: 18,
    });
    const autoLog: ConsumptionLog = {
      id: exactAutoLogId('med-1', 'd1', TODAY),
      medicationId: 'med-1',
      doseId: 'd1',
      amount: -2,
      type: 'exact_auto',
      timestamp: '2026-09-14T08:00:00.000Z',
      date: TODAY,
    };
    const now = new Date('2026-09-14T15:00:00');

    const first = restoreDose(med, 'd1', TODAY, now, [autoLog]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.reversedLogId).toBe(exactAutoLogId('med-1', 'd1', TODAY));
    expect(first.restoredAmount).toBe(2);

    // Simulate reversed auto + new manual take
    const reversedAuto = { ...autoLog, reversedAt: '2026-09-14T15:01:00.000Z' };
    const takeLog: ConsumptionLog = {
      id: 'take-d1',
      medicationId: 'med-1',
      doseId: 'd1',
      amount: -2,
      type: 'dose_taken',
      timestamp: '2026-09-14T15:02:00.000Z',
      date: TODAY,
    };
    const afterTake: Medication = {
      ...first.updatedMed,
      doseConsumptionHistory: { d1: [TODAY] },
      currentPills: 18,
    };
    const second = restoreDose(afterTake, 'd1', TODAY, now, [
      reversedAuto,
      takeLog,
    ]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reversedLogId).toBe('take-d1');
    expect(second.restoredAmount).toBe(2);
    expect(second.reversedLogId).not.toBe(exactAutoLogId('med-1', 'd1', TODAY));
  });

  it('consumed marker without active deduction log fails closed (no stock, no invent)', () => {
    const med = makeMed({
      doseConsumptionHistory: { d1: [TODAY] },
      currentPills: 18,
      doseSchedule: [
        { id: 'd1', time: '08:00', amount: 5 },
        { id: 'd2', time: '14:00', amount: 1 },
      ],
    });
    const result = restoreDose(
      med,
      'd1',
      TODAY,
      new Date('2026-09-14T15:00:00'),
      [] // no matching logs
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_deduction_evidence');
  });

  it('no durable deduction evidence → missing_deduction_evidence, stock unchanged', () => {
    const med = makeMed({
      doseConsumptionHistory: {},
      currentPills: 20,
    });
    const result = restoreDose(
      med,
      'd1',
      TODAY,
      new Date('2026-09-14T15:00:00'),
      []
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_deduction_evidence');
    expect(med.currentPills).toBe(20);
  });

  it('missing dose identity is not valid Restore evidence', () => {
    const med = makeMed({
      doseSchedule: [{ id: 'd1', time: '08:00', amount: 2 }],
      doseConsumptionHistory: { d1: [TODAY] },
      currentPills: 18,
    });
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med-1', 'd1', TODAY),
        medicationId: 'med-1',
        // no doseId — not valid occurrence evidence under #267
        amount: -2,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
    ];
    const result = restoreDose(
      med,
      'd1',
      TODAY,
      new Date('2026-09-14T15:00:00'),
      logs
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_deduction_evidence');
    expect(med.currentPills).toBe(18);
  });
});
