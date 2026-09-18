import { describe, it, expect } from 'vitest';
import { getHistoricalRestoreDisplayAmount } from '@/utils/medActions';
import type { ConsumptionLog } from '@/types';

const TODAY = '2026-09-14';

describe('getHistoricalRestoreDisplayAmount — UI restore amount contract', () => {
  it('missing evidence: null (must not invent schedule amount 5)', () => {
    expect(
      getHistoricalRestoreDisplayAmount([], 'med', 'd1', TODAY)
    ).toBeNull();
  });

  it('exact evidence: uses log amount even when schedule would be 10', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'a',
        medicationId: 'med',
        doseId: 'd1',
        amount: -5,
        type: 'auto_daily',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
    ];
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBe(5);
  });

  it('sibling isolation: A=5, B=10', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'a',
        medicationId: 'med',
        doseId: 'd1',
        amount: -5,
        type: 'auto_daily',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
      {
        id: 'b',
        medicationId: 'med',
        doseId: 'd2',
        amount: -10,
        type: 'dose_taken',
        timestamp: '2026-09-14T14:00:00.000Z',
        date: TODAY,
      },
    ];
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBe(5);
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd2', TODAY)
    ).toBe(10);
  });

  it('schedule edit after deduction: display stays on log amount', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'a',
        medicationId: 'med',
        doseId: 'd1',
        amount: -5,
        type: 'auto_daily',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
    ];
    // UI contract: never replace with current schedule 10
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBe(5);
  });
});
