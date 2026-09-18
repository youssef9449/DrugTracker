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

/**
 * UI Restore eligibility contract (SelectDoseModal / MedicationCard):
 * - consumed + evidence → restorable
 * - consumed + no evidence → NOT restorable
 * - pure auto projection → restorable without log
 * - sibling dose evidence does not satisfy another doseId
 */
describe('UI Restore eligibility contract (derived)', () => {
  const TODAY = '2026-09-14';

  function canHistoricalRestore(
    consumed: boolean,
    skipped: boolean,
    evidence: number | null
  ): boolean {
    return consumed && !skipped && evidence != null;
  }

  function canPureAutoProjection(
    isAutoActive: boolean,
    completed: boolean,
    consumed: boolean,
    skipped: boolean,
    elapsed: boolean
  ): boolean {
    return (
      isAutoActive && completed && !consumed && !skipped && elapsed
    );
  }

  it('consumed + exact evidence → restorable', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'a',
        medicationId: 'med',
        doseId: 'd1',
        amount: -5,
        type: 'dose_taken',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: TODAY,
      },
    ];
    const evidence = getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY);
    expect(evidence).toBe(5);
    expect(canHistoricalRestore(true, false, evidence)).toBe(true);
  });

  it('consumed + missing evidence → not restorable', () => {
    const evidence = getHistoricalRestoreDisplayAmount([], 'med', 'd1', TODAY);
    expect(evidence).toBeNull();
    expect(canHistoricalRestore(true, false, evidence)).toBe(false);
  });

  it('pure auto projection + no deduction → still restorable', () => {
    expect(
      canPureAutoProjection(true, true, false, false, true)
    ).toBe(true);
    expect(
      getHistoricalRestoreDisplayAmount([], 'med', 'd1', TODAY)
    ).toBeNull();
  });

  it('consumed + sibling-only evidence → not restorable for this doseId', () => {
    const logs: ConsumptionLog[] = [
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
    const evidence = getHistoricalRestoreDisplayAmount(logs, 'med', 'd1', TODAY);
    expect(evidence).toBeNull();
    expect(canHistoricalRestore(true, false, evidence)).toBe(false);
  });

  it('allDone restore-mode: true when only non-restorable completed doses', () => {
    // conceptual: every dose fails both historical and pure-auto
    const doses = [
      { historical: false, pureAuto: false },
      { historical: false, pureAuto: false },
    ];
    const allDone = doses.every((d) => !(d.historical || d.pureAuto));
    expect(allDone).toBe(true);
  });

  it('allDone restore-mode: false when any historical or pure-auto remains', () => {
    expect(
      [{ historical: true, pureAuto: false }].every(
        (d) => !(d.historical || d.pureAuto)
      )
    ).toBe(false);
    expect(
      [{ historical: false, pureAuto: true }].every(
        (d) => !(d.historical || d.pureAuto)
      )
    ).toBe(false);
  });
});
