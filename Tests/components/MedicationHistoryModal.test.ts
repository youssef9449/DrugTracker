import { requireDefined } from '../helpers/requireDefined';
import { describe, it, expect } from 'vitest';
import type { ConsumptionLog } from '@/types';
import {
  filterLogsForMedication,
  historyAmountPresentation,
  formatHistoryAmountText,
} from '@/components/MedicationHistoryModal';

function makeLog(overrides: Partial<ConsumptionLog> & Pick<ConsumptionLog, 'id' | 'medicationId'>): ConsumptionLog {
  return {
    medicationName: 'X',
    type: 'dose_taken',
    amount: -1,
    date: '2026-01-01',
    timestamp: '2026-01-01T08:00:00.000Z',
    description: 'test',
    ...overrides,
  };
}

describe('filterLogsForMedication — identity is medicationId only', () => {
  it('Case A: same name, different IDs — histories stay independent', () => {
    const logs: ConsumptionLog[] = [
      makeLog({ id: '1', medicationId: 'A', medicationName: 'Panadol', amount: -1, description: 'A dose' }),
      makeLog({ id: '2', medicationId: 'B', medicationName: 'Panadol', amount: -2, description: 'B dose' }),
    ];
    const aLogs = filterLogsForMedication(logs, 'A');
    const bLogs = filterLogsForMedication(logs, 'B');
    expect(aLogs.map((l) => l.id)).toEqual(['1']);
    expect(bLogs.map((l) => l.id)).toEqual(['2']);
    expect(aLogs.some((l) => l.medicationId === 'B')).toBe(false);
    expect(bLogs.some((l) => l.medicationId === 'A')).toBe(false);
  });

  it('Case B: stale historical name still matches by medicationId', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'stale',
        medicationId: 'med-1',
        medicationName: 'Old Name',
        amount: -1,
      }),
    ];
    const filtered = filterLogsForMedication(logs, 'med-1');
    expect(filtered).toHaveLength(1);
    expect(requireDefined(filtered[0], 'filtered[0]').medicationName).toBe('Old Name');
  });

  it('Case C: matching name but different medicationId is excluded', () => {
    const logs: ConsumptionLog[] = [
      makeLog({
        id: 'other',
        medicationId: 'other-id',
        medicationName: 'Panadol',
        amount: -1,
      }),
    ];
    expect(filterLogsForMedication(logs, 'my-id')).toHaveLength(0);
  });
});

describe('historyAmountPresentation — zero exact_auto is neutral', () => {
  it('Case A: exact_auto amount 0 → neutral, no -0 text', () => {
    expect(historyAmountPresentation({ type: 'exact_auto', amount: 0 })).toBe('neutral');
    expect(formatHistoryAmountText(0, 'قرص')).toBe('0 قرص');
    expect(formatHistoryAmountText(0, 'قرص')).not.toContain('-');
  });

  it('Case B: exact_auto negative deduction remains out', () => {
    expect(historyAmountPresentation({ type: 'exact_auto', amount: -2 })).toBe('out');
    expect(formatHistoryAmountText(-2, 'قرص')).toBe('-2 قرص');
  });

  it('Case C: positive refill remains in', () => {
    expect(historyAmountPresentation({ type: 'refill', amount: 10 })).toBe('in');
    expect(formatHistoryAmountText(10, 'قرص')).toBe('+10 قرص');
  });
});
