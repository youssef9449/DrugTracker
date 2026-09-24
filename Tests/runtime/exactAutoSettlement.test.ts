import { describe, expect, it, vi } from 'vitest';
import {
  getExactOccurrenceSettlementState,
  applyExactAutoEventToMedication,
  exactAutoLogId,
} from '@/utils/autoDeductionReconciliation';
import type { ConsumptionLog, Medication } from '@/types';

function med(): Medication {
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

const DATE = '2026-09-13';

function firedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    medicationId: 'med-1',
    doseId: 'd1',
    calendarDate: DATE,
    amount: 2,
    status: 'FIRED',
    ...overrides,
  } as unknown as Parameters<typeof applyExactAutoEventToMedication>[1];
}

describe('canonical exact-occurrence settlement decision (#532)', () => {
  it('unsettled when no durable evidence exists', () => {
    expect(getExactOccurrenceSettlementState([], med(), 'd1', DATE)).toEqual({
      state: 'unsettled',
    });
  });

  it('logged when the deterministic exact log exists', () => {
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med-1', 'd1', DATE),
        medicationId: 'med-1',
        medicationName: 'Med',
        type: 'exact_auto',
        amount: -2,
        date: DATE,
        timestamp: 'x',
        description: '',
        doseId: 'd1',
      },
    ];
    expect(getExactOccurrenceSettlementState(logs, med(), 'd1', DATE)).toEqual({
      state: 'logged',
      source: 'exact_log',
    });
  });

  it('consumed / skipped via per-dose markers', () => {
    const consumed = {
      ...med(),
      doseConsumptionHistory: { d1: [DATE] },
    };
    expect(getExactOccurrenceSettlementState([], consumed, 'd1', DATE)).toEqual({
      state: 'consumed',
      source: 'consume_marker',
    });
    const skipped = {
      ...med(),
      doseSkippedHistory: { d1: [DATE] },
    };
    expect(getExactOccurrenceSettlementState([], skipped, 'd1', DATE)).toEqual({
      state: 'skipped',
      source: 'skip_marker',
    });
  });

  it('repeated application stays idempotent under retries/replay', () => {
    const first = applyExactAutoEventToMedication(med(), firedEvent());
    expect(first.ok).toBe(true);
    if (first.ok) {
      const second = applyExactAutoEventToMedication(first.updatedMed, firedEvent());
      expect(second).toEqual({ ok: false, reason: 'already_applied' });
    }
  });
});

describe('native stock result contract validation (#524)', () => {
  it('accepts a valid native partial deduction', () => {
    const result = applyExactAutoEventToMedication(
      med(),
      firedEvent({ nativeStockApplied: true, actualDeducted: 1 })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an oversized native amount (more than requested)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = applyExactAutoEventToMedication(
      med(),
      firedEvent({ nativeStockApplied: true, actualDeducted: 5 }) // requested 2
    );
    expect(result).toEqual({
      ok: false,
      reason: 'native_stock_result_contract_violation',
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects a native amount exceeding the settle base', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lowStock = { ...med(), currentPills: 1 };
    const result = applyExactAutoEventToMedication(
      lowStock,
      firedEvent({ nativeStockApplied: true, actualDeducted: 2 }) // requested 2, base 1
    );
    expect(result).toEqual({
      ok: false,
      reason: 'native_stock_result_contract_violation',
    });
    warn.mockRestore();
  });

  it('rejects a malformed native amount', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      applyExactAutoEventToMedication(
        med(),
        firedEvent({ nativeStockApplied: true, actualDeducted: Number.NaN })
      ).ok
    ).toBe(false);
    expect(
      applyExactAutoEventToMedication(
        med(),
        firedEvent({ nativeStockApplied: true, actualDeducted: -1 })
      ).ok
    ).toBe(false);
    warn.mockRestore();
  });
});
