import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Write-order invariant pin (legacy-envelope "3b proof" premise).
 *
 * The legacy Exact-Auto envelope recovery case 3b proves "the medications
 * snapshot landed" from the presence of the envelope's log IDs. That proof is
 * only sound because every producer of those logs writes medications BEFORE
 * logs. This test mechanically pins the invariant in the single durable
 * writer: commitDurableAutoStockState must persist in the exact order
 *
 *   medications → logs → global master switch → lastAppliedMutationSeq → stock generation
 *
 * and must stop at the first failed write (fail-closed — a later write may
 * never land while an earlier one failed).
 */

const mocks = vi.hoisted(() => {
  const writeOrder: string[] = [];
  return {
    writeOrder,
    persist: vi.fn(),
    persistLastAppliedMutationSeq: vi.fn(),
    loadString: vi.fn(),
    loadJson: vi.fn(),
  };
});

vi.mock('../../src/utils/storage', () => ({
  persist: mocks.persist,
  loadJson: mocks.loadJson,
  loadString: mocks.loadString,
}));

vi.mock('../../src/utils/stockMutationOrdering', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/stockMutationOrdering')>(
    '../../src/utils/stockMutationOrdering'
  );
  return {
    ...actual,
    persistLastAppliedMutationSeq: mocks.persistLastAppliedMutationSeq,
  };
});

import {
  commitDurableAutoStockState,
  STORAGE_MEDS_KEY,
  STORAGE_LOGS_KEY,
  STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
  STORAGE_STOCK_GEN_KEY } from '../../src/utils/autoDeductionStockGate';
import type { ConsumptionLog, Medication } from '../../src/types';

const LAST_APPLIED_MARKER = 'lastAppliedMutationSeq';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-14',
    autoDeductEnabled: true,
    ...over,
  };
}

describe('commitDurableAutoStockState — durable write order (meds before logs)', () => {
  beforeEach(() => {
    mocks.writeOrder.length = 0;
    mocks.persist.mockReset();
    mocks.persist.mockImplementation((key: string) => {
      mocks.writeOrder.push(key);
      return null;
    });
    mocks.loadString.mockReset();
    mocks.loadString.mockReturnValue('0');
    mocks.loadJson.mockReset();
    mocks.loadJson.mockReturnValue(null);
    mocks.persistLastAppliedMutationSeq.mockReset();
    mocks.persistLastAppliedMutationSeq.mockImplementation(() => {
      mocks.writeOrder.push(LAST_APPLIED_MARKER);
      return null;
    });
  });

  it('persists medications → logs → global → lastAppliedMutationSeq → generation', () => {
    const err = commitDurableAutoStockState(
      {
        medications: [baseMed()],
        logs: [] as ConsumptionLog[],
        globalAutoDeductEnabled: true,
      },
      { appliedMutationSeq: 5 }
    );

    expect(err).toBeNull();
    expect(mocks.writeOrder).toEqual([
      STORAGE_MEDS_KEY,
      STORAGE_LOGS_KEY,
      STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
      LAST_APPLIED_MARKER,
      STORAGE_STOCK_GEN_KEY,
    ]);
  });

  it('stops at the first failed write — logs failure blocks global/seq/generation', () => {
    mocks.persist.mockImplementation((key: string) => {
      mocks.writeOrder.push(key);
      return key === STORAGE_LOGS_KEY ? 'storage_quota' : null;
    });

    const err = commitDurableAutoStockState(
      {
        medications: [baseMed()],
        logs: [] as ConsumptionLog[],
        globalAutoDeductEnabled: true,
      },
      { appliedMutationSeq: 5 }
    );

    expect(err).toBe('storage_quota');
    // Nothing after the failed logs write may land — otherwise downstream
    // readers could observe a finalization marker without its snapshot.
    expect(mocks.writeOrder).toEqual([STORAGE_MEDS_KEY, STORAGE_LOGS_KEY]);
  });

  it('stops at medications failure — nothing else is written', () => {
    mocks.persist.mockImplementation((key: string) => {
      mocks.writeOrder.push(key);
      return key === STORAGE_MEDS_KEY ? 'storage_quota' : null;
    });

    const err = commitDurableAutoStockState(
      {
        medications: [baseMed()],
        logs: [] as ConsumptionLog[],
        globalAutoDeductEnabled: true,
      },
      { appliedMutationSeq: 5 }
    );

    expect(err).toBe('storage_quota');
    expect(mocks.writeOrder).toEqual([STORAGE_MEDS_KEY]);
  });

  it('omits the global write when the state carries no master switch', () => {
    const err = commitDurableAutoStockState(
      {
        medications: [baseMed()],
        logs: [] as ConsumptionLog[],
      },
      { appliedMutationSeq: 5 }
    );

    expect(err).toBeNull();
    expect(mocks.writeOrder).toEqual([
      STORAGE_MEDS_KEY,
      STORAGE_LOGS_KEY,
      LAST_APPLIED_MARKER,
      STORAGE_STOCK_GEN_KEY,
    ]);
  });
});
