import { describe, it, expect } from 'vitest';
import {
  getHistoricalRestoreDisplayAmount,
  isUiAutoHistoricalRestoreEligible,
  isUiConsumedRestoreEligible,
  isUiPureAutoProjectionRestoreEligible,
} from '@/utils/medActions';
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
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBe(5);
  });

  it('zero amount log is not valid evidence', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'z',
        medicationId: 'med',
        doseId: 'd1',
        amount: 0,
        type: 'auto_daily',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
    ];
    expect(
      getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY)
    ).toBeNull();
  });
});

describe('production UI Restore eligibility helpers (UI-8)', () => {
  it('Auto consumed + valid evidence → Restore eligible', () => {
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
    const historicalAmount = getHistoricalRestoreDisplayAmount(
      logs,
      'med',
      'd1',
      TODAY
    );
    expect(historicalAmount).toBe(5);
    expect(
      isUiAutoHistoricalRestoreEligible(
        true,
        false,
        'auto_daily',
        historicalAmount
      )
    ).toBe(true);
  });

  it('UI-8: Auto consumed + type auto_daily but missing amount evidence → NOT eligible', () => {
    // activeDeduction.type === auto_daily but amount invalid / no usable evidence
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, 'auto_daily', null)
    ).toBe(false);
  });

  it('Manual consumed + missing evidence → NOT eligible', () => {
    expect(isUiConsumedRestoreEligible(true, false, null)).toBe(false);
  });

  it('Manual consumed + valid evidence → eligible', () => {
    expect(isUiConsumedRestoreEligible(true, false, 2)).toBe(true);
  });

  it('Pure auto projection + no deduction → eligible (no log required)', () => {
    expect(
      isUiPureAutoProjectionRestoreEligible(true, true, false, false, true)
    ).toBe(true);
    expect(
      getHistoricalRestoreDisplayAmount([], 'med', 'd1', TODAY)
    ).toBeNull();
  });

  it('Sibling isolation: other doseId evidence does not enable this dose', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'b',
        medicationId: 'med',
        doseId: 'd2',
        amount: -10,
        type: 'auto_daily',
        timestamp: '2026-09-14T14:00:00.000Z',
        date: TODAY,
      },
    ];
    const evidence = getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY);
    expect(evidence).toBeNull();
    expect(
      isUiAutoHistoricalRestoreEligible(true, false, 'auto_daily', evidence)
    ).toBe(false);
    expect(isUiConsumedRestoreEligible(true, false, evidence)).toBe(false);
  });

  it('allDone restore-mode uses production eligibility', () => {
    const doses = [
      {
        can:
          isUiConsumedRestoreEligible(true, false, null) ||
          isUiPureAutoProjectionRestoreEligible(true, true, false, false, false),
      },
      {
        can:
          isUiConsumedRestoreEligible(true, false, null) ||
          isUiPureAutoProjectionRestoreEligible(true, true, false, false, false),
      },
    ];
    expect(doses.every((d) => !d.can)).toBe(true);

    const withEvidence = [
      {
        can:
          isUiConsumedRestoreEligible(true, false, 5) ||
          isUiPureAutoProjectionRestoreEligible(false, false, false, false, false),
      },
    ];
    expect(withEvidence.every((d) => !d.can)).toBe(false);

    const withPureAuto = [
      {
        can:
          isUiConsumedRestoreEligible(false, false, null) ||
          isUiPureAutoProjectionRestoreEligible(true, true, false, false, true),
      },
    ];
    expect(withPureAuto.every((d) => !d.can)).toBe(false);
  });
});
