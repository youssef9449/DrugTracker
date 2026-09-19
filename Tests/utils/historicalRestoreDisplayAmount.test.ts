import { describe, it, expect } from 'vitest';
import {
  getHistoricalRestoreDisplayAmount,
  isUiAutoHistoricalRestoreEligible,
  isUiConsumedRestoreEligible,
  isExactAutoDeductionEvidence,
} from '@/utils/medActions';
import type { ConsumptionLog } from '@/types';
import { exactAutoLogId } from '@/utils/autoDeductionReconciliation';

const TODAY = '2026-09-14';

function exactLog(
  overrides: Partial<ConsumptionLog> & { doseId: string; amount: number }
): ConsumptionLog {
  const doseId = overrides.doseId;
  return {
    id: exactAutoLogId('med', doseId, TODAY),
    medicationId: 'med',
    medicationName: 'Med',
    type: 'exact_auto',
    date: TODAY,
    timestamp: '2026-09-14T08:00:00.000Z',
    description: 'exact',
    ...overrides,
  };
}

describe('getHistoricalRestoreDisplayAmount — UI restore amount contract', () => {
  it('missing evidence: null (must not invent schedule amount 5)', () => {
    expect(
      getHistoricalRestoreDisplayAmount([], 'med', 'd1', TODAY)
    ).toBeNull();
  });

  it('exact evidence: uses log amount even when schedule would be 10', () => {
    const logs: ConsumptionLog[] = [exactLog({ doseId: 'd1', amount: -5 })];
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBe(5);
  });

  it('sibling isolation: A=5, B=10', () => {
    const logs: ConsumptionLog[] = [
      exactLog({ doseId: 'd1', amount: -5 }),
      {
        id: 'b',
        medicationId: 'med',
        medicationName: 'Med',
        doseId: 'd2',
        amount: -10,
        type: 'dose_taken',
        timestamp: '2026-09-14T14:00:00.000Z',
        date: TODAY,
        description: 'manual',
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
    const logs: ConsumptionLog[] = [exactLog({ doseId: 'd1', amount: -5 })];
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBe(5);
  });

  it('zero amount log is not valid evidence', () => {
    const logs: ConsumptionLog[] = [exactLog({ doseId: 'd1', amount: 0 })];
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBeNull();
  });
});

describe('production UI Restore eligibility helpers', () => {
  it('UI: Exact Auto consumed + exact_auto evidence → eligible', () => {
    const log = exactLog({ doseId: 'd1', amount: -2 });
    const historicalAmount = getHistoricalRestoreDisplayAmount(
      [log],
      'med',
      'd1',
      TODAY
    );
    expect(
      isUiAutoHistoricalRestoreEligible(
        true,
        false,
        log,
        historicalAmount,
        'med',
        'd1',
        TODAY
      )
    ).toBe(true);
  });

  it('UI: Exact Auto consumed + type exact_auto but missing amount evidence → NOT eligible', () => {
    const log = exactLog({ doseId: 'd1', amount: -2 });
    expect(
      isUiAutoHistoricalRestoreEligible(
        true,
        false,
        log,
        null,
        'med',
        'd1',
        TODAY
      )
    ).toBe(false);
  });

  it('Manual consumed + missing evidence → NOT eligible', () => {
    expect(isUiConsumedRestoreEligible(true, false, null)).toBe(false);
  });

  it('Manual consumed + valid evidence → eligible', () => {
    expect(isUiConsumedRestoreEligible(true, false, 2)).toBe(true);
  });

  it('Sibling isolation: other doseId evidence does not enable this dose', () => {
    const logs: ConsumptionLog[] = [exactLog({ doseId: 'd2', amount: -10 })];
    const evidence = getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY);
    expect(evidence).toBeNull();
    expect(
      isUiAutoHistoricalRestoreEligible(
        true,
        false,
        logs[0],
        evidence,
        'med',
        'd1',
        TODAY
      )
    ).toBe(false);
    expect(isUiConsumedRestoreEligible(true, false, evidence)).toBe(false);
  });

  it('legacy auto_daily with deterministic Exact id remains readable/restorable', () => {
    const id = exactAutoLogId('med', 'd1', TODAY);
    const legacyExact: ConsumptionLog = {
      id,
      medicationId: 'med',
      medicationName: 'Med',
      type: 'auto_daily',
      amount: -3,
      date: TODAY,
      timestamp: '2026-09-14T08:00:00.000Z',
      description: 'legacy exact',
      doseId: 'd1',
    };
    expect(
      isExactAutoDeductionEvidence(legacyExact, 'med', 'd1', TODAY)
    ).toBe(true);
    expect(
      getHistoricalRestoreDisplayAmount([legacyExact], 'med', 'd1', TODAY)
    ).toBe(3);
    expect(
      isUiAutoHistoricalRestoreEligible(
        true,
        false,
        legacyExact,
        3,
        'med',
        'd1',
        TODAY
      )
    ).toBe(true);
  });

  it('ordinary legacy auto_daily is NOT treated as Exact Auto occurrence', () => {
    const ordinary: ConsumptionLog = {
      id: 'log-init-1',
      medicationId: 'med',
      medicationName: 'Med',
      type: 'auto_daily',
      amount: -1,
      date: TODAY,
      timestamp: '2026-09-14T08:00:00.000Z',
      description: 'legacy day bulk',
      doseId: 'd1',
    };
    expect(
      isExactAutoDeductionEvidence(ordinary, 'med', 'd1', TODAY)
    ).toBe(false);
    expect(
      getHistoricalRestoreDisplayAmount([ordinary], 'med', 'd1', TODAY)
    ).toBeNull();
    expect(
      isUiAutoHistoricalRestoreEligible(
        true,
        false,
        ordinary,
        1,
        'med',
        'd1',
        TODAY
      )
    ).toBe(false);
  });
});
