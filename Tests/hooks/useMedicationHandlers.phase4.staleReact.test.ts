/**
 * Phase 4 — handler-level stale React snapshot races.
 *
 * These tests exercise useMedicationHandlers itself (not only
 * runGatedManualRestore / runGatedRefill). React state is intentionally
 * empty or outdated while durable gate state holds the truth.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Medication, ConsumptionLog } from '../../src/types';
import { useMedicationHandlers } from '../../src/hooks/useMedicationHandlers';
import {
  __setAutoStockGateTestHooks,
  type AutoStockDurableState,
} from '../../src/utils/autoDeductionStockGate';
import { __setManualEnvelopeTestHooks } from '../../src/utils/stockEnvelopeRecovery';
import {
  __setStockMutationOrderingTestHooks,
  __resetStockMutationOrderingForTests,
} from '../../src/utils/stockMutationOrdering';
import { isDoseConsumedOnDate } from '../../src/utils/dateCalculations';

const TODAY = '2026-09-16';

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 10,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-15',
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 2, time: '22:00' },
    ],
    dosesPerDay: 3,
    ...over,
  };
}

describe('useMedicationHandlers — stale React must not block durable mutations', () => {
  let durable: AutoStockDurableState;
  let reactMeds: Medication[];
  let reactLogs: ConsumptionLog[];
  let setMedications: ReturnType<typeof vi.fn>;
  let setLogs: ReturnType<typeof vi.fn>;
  let showToast: ReturnType<typeof vi.fn>;
  let nextSeq: number;
  let lastApplied: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00`));
    durable = { medications: [med()], logs: [] };
    reactMeds = []; // empty React snapshot by default
    reactLogs = [];
    setMedications = vi.fn((next: Medication[] | ((p: Medication[]) => Medication[])) => {
      const value = typeof next === 'function' ? next(reactMeds) : next;
      reactMeds = value;
      // Mirror UI state write into durable for realism when gate commits via hooks.
    });
    setLogs = vi.fn((next: ConsumptionLog[] | ((p: ConsumptionLog[]) => ConsumptionLog[])) => {
      const value = typeof next === 'function' ? next(reactLogs) : next;
      reactLogs = value;
    });
    showToast = vi.fn();
    nextSeq = 0;
    lastApplied = 0;

    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (next) => {
        durable = {
          medications: next.medications.map((m) => ({ ...m })),
          logs: next.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
    __setManualEnvelopeTestHooks({
      load: () => null,
      save: () => null,
      clear: () => null,
    });
    // Match production allocateMutationSeq contract:
    // { ok: true, seq } | { ok: false, error }. Keep nextSeq and lastApplied separate.
    __setStockMutationOrderingTestHooks({
      allocate: () => {
        nextSeq += 1;
        return { ok: true, seq: nextSeq };
      },
      loadLastApplied: () => lastApplied,
      persistLastApplied: (value) => {
        lastApplied = value;
        return null;
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __resetStockMutationOrderingForTests();
  });

  function mountHandlers() {
    // Always read current reactMeds/reactLogs via closure on each render.
    const { result, rerender } = renderHook(
      ({ medications, logs }: { medications: Medication[]; logs: ConsumptionLog[] }) =>
        useMedicationHandlers({
          medications,
          logs,
          soundEnabled: false,
          globalAutoDeductEnabled: true,
          notificationsEnabled: false,
          criticalStockAlertsEnabled: false,
          selectDoseMode: 'restore',
          setMedications: setMedications as never,
          setLogs: setLogs as never,
          setGlobalAutoDeductEnabled: vi.fn(),
          setIsAutoDeductPromptOpen: vi.fn(),
          setNotificationsEnabled: vi.fn(),
          setCriticalStockAlertsEnabled: vi.fn(),
          setSelectDoseMed: vi.fn(),
          setSelectDoseMode: vi.fn(),
          setEditingMedication: vi.fn(),
          showToast,
          dismissAlarm: vi.fn(),
          snoozeAlarm: vi.fn(),
        }),
      { initialProps: { medications: reactMeds, logs: reactLogs } }
    );
    return {
      result,
      rerender: () =>
        rerender({ medications: reactMeds, logs: reactLogs }),
    };
  }

  it('Restore reaches gate when React snapshot has no medication but durable does', async () => {
    // Durable has a manual take ready to restore.
    durable = {
      medications: [
        med({
          currentPills: 9,
          doseConsumption: { d1: TODAY },
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: 'take-1',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: -1,
          date: TODAY,
          timestamp: `${TODAY}T10:00:00.000Z`,
          description: 'take',
          doseId: 'd1',
        },
      ],
    };
    reactMeds = []; // empty React
    const { result } = mountHandlers();

    let updated: Medication | null = null;
    await act(async () => {
      updated = await result.current.handleRestoreDose('med-1', 'test', 'd1');
    });

    expect(updated).not.toBeNull();
    expect(updated!.currentPills).toBe(10);
    expect(durable.medications[0].currentPills).toBe(10);
    expect(setMedications).toHaveBeenCalled();
  });

  it('Restore works when React doseSchedule is stale and missing the doseId', async () => {
    durable = {
      medications: [
        med({
          currentPills: 9,
          doseConsumption: { d1: TODAY },
          doseConsumptionHistory: { d1: [TODAY] },
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
          ],
        }),
      ],
      logs: [
        {
          id: 'take-1',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: -1,
          date: TODAY,
          timestamp: `${TODAY}T10:00:00.000Z`,
          description: 'take',
          doseId: 'd1',
        },
      ],
    };
    // Stale React: only knows about d2 schedule, no d1, no consume markers.
    reactMeds = [
      med({
        currentPills: 10,
        doseSchedule: [{ id: 'd2', amount: 1, time: '14:00' }],
        doseConsumption: {},
        doseConsumptionHistory: {},
      }),
    ];
    const { result } = mountHandlers();

    let updated: Medication | null = null;
    await act(async () => {
      updated = await result.current.handleRestoreDose('med-1', 'test', 'd1');
    });

    expect(updated).not.toBeNull();
    expect(durable.medications[0].currentPills).toBe(10);
  });

  it('stale React skip/consumed does not prevent Restore', async () => {
    durable = {
      medications: [
        med({
          currentPills: 9,
          doseConsumption: { d1: TODAY },
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: 'take-1',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: -1,
          date: TODAY,
          timestamp: `${TODAY}T10:00:00.000Z`,
          description: 'take',
          doseId: 'd1',
        },
      ],
    };
    reactMeds = [
      med({
        currentPills: 10,
        doseSkippedHistory: { d1: [TODAY] },
        doseConsumption: {},
        doseConsumptionHistory: {},
      }),
    ];
    expect(isDoseConsumedOnDate(reactMeds[0], 'd1', TODAY)).toBe(false);

    const { result } = mountHandlers();
    let updated: Medication | null = null;
    await act(async () => {
      updated = await result.current.handleRestoreDose('med-1', 'test', 'd1');
    });
    expect(updated).not.toBeNull();
    expect(durable.medications[0].currentPills).toBe(10);
  });

  it('double-click Restore is guarded (second call no-ops while in flight)', async () => {
    durable = {
      medications: [
        med({
          currentPills: 9,
          doseConsumption: { d1: TODAY },
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: 'take-1',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: -1,
          date: TODAY,
          timestamp: `${TODAY}T10:00:00.000Z`,
          description: 'take',
          doseId: 'd1',
        },
      ],
    };
    reactMeds = [];

    const { result } = mountHandlers();
    // Fire both without awaiting the first so restoreInFlightRef blocks the second.
    let first!: Promise<Medication | null>;
    let second!: Promise<Medication | null>;
    await act(async () => {
      first = result.current.handleRestoreDose('med-1', 'test', 'd1');
      second = result.current.handleRestoreDose('med-1', 'test', 'd1');
      await Promise.all([first, second]);
    });
    const results = [await first, await second];
    // One applied (returns med), one blocked by in-flight (null).
    const applied = results.filter((r) => r != null);
    expect(applied).toHaveLength(1);
    expect(durable.medications[0].currentPills).toBe(10);
  });

  it('Confirm Refill works when React medications is empty', async () => {
    durable = { medications: [med({ currentPills: 5 })], logs: [] };
    reactMeds = [];
    const { result } = mountHandlers();

    await act(async () => {
      result.current.handleConfirmRefill('med-1', 10);
      // flush microtasks for the void async IIFE
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(durable.medications[0].currentPills).toBe(15);
    });
    expect(setMedications).toHaveBeenCalled();
  });

  it('Undo Refill reverses durable newest refill even when React logs are stale', async () => {
    durable = {
      medications: [med({ currentPills: 30 })],
      logs: [
        {
          id: 'refill-new',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'refill',
          amount: 10,
          date: TODAY,
          timestamp: `${TODAY}T12:00:00.000Z`,
          description: 'new',
        },
        {
          id: 'refill-old',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'refill',
          amount: 5,
          date: TODAY,
          timestamp: `${TODAY}T08:00:00.000Z`,
          description: 'old',
        },
      ],
    };
    // React only knows the old refill and has no med.
    reactMeds = [];
    reactLogs = [
      {
        id: 'refill-old',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'refill',
        amount: 5,
        date: TODAY,
        timestamp: `${TODAY}T08:00:00.000Z`,
        description: 'old',
      },
    ];

    const { result } = mountHandlers();
    await act(async () => {
      result.current.handleUndoRefill('med-1');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(durable.logs.find((l) => l.id === 'refill-new')?.reversedAt).toBeTruthy();
    });
    expect(durable.logs.find((l) => l.id === 'refill-old')?.reversedAt).toBeFalsy();
    expect(showToast).toHaveBeenCalled();
  });


  // ─── Manual Take: React snapshot must not decide business outcome ───

  it('Take succeeds when React medications is empty but durable has med + doseId', async () => {
    durable = {
      medications: [med({ currentPills: 10 })],
      logs: [],
    };
    reactMeds = [];
    const { result } = mountHandlers();

    await act(async () => {
      result.current.handleConsumeDose('med-1', 'd1');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(durable.medications[0].currentPills).toBe(9);
    });
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
    expect(setMedications).toHaveBeenCalled();
  });

  it('Take uses durable schedule when React doseSchedule is stale', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [
            { id: 'd1', amount: 3, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
          ],
        }),
      ],
      logs: [],
    };
    // Stale React: only knows d2 with amount 1
    reactMeds = [
      med({
        currentPills: 10,
        doseSchedule: [{ id: 'd2', amount: 1, time: '14:00' }],
      }),
    ];
    const { result } = mountHandlers();

    await act(async () => {
      result.current.handleConsumeDose('med-1', 'd1');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(durable.medications[0].currentPills).toBe(7); // deducted 3 from durable
    });
  });

  it('Take uses durable truth when React says already consumed but durable is not', async () => {
    durable = { medications: [med({ currentPills: 10 })], logs: [] };
    reactMeds = [
      med({
        currentPills: 9,
        doseConsumption: { d1: TODAY },
        doseConsumptionHistory: { d1: [TODAY] },
      }),
    ];
    expect(isDoseConsumedOnDate(reactMeds[0], 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(false);

    const { result } = mountHandlers();
    await act(async () => {
      result.current.handleConsumeDose('med-1', 'd1');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(durable.medications[0].currentPills).toBe(9);
    });
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
  });

  it('Take is already_consumed when durable is consumed even if React is not', async () => {
    durable = {
      medications: [
        med({
          currentPills: 9,
          doseConsumption: { d1: TODAY },
          doseConsumptionHistory: { d1: [TODAY] },
        }),
      ],
      logs: [
        {
          id: 'take-1',
          medicationId: 'med-1',
          medicationName: 'TestMed',
          type: 'dose_taken',
          amount: -1,
          date: TODAY,
          timestamp: `${TODAY}T10:00:00.000Z`,
          description: 'take',
          doseId: 'd1',
        },
      ],
    };
    reactMeds = [med({ currentPills: 10 })]; // not consumed in React
    const pillsBefore = durable.medications[0].currentPills;

    const { result } = mountHandlers();
    await act(async () => {
      result.current.handleConsumeDose('med-1', 'd1');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect(durable.medications[0].currentPills).toBe(pillsBefore);
  });

  it('Take with durable doseId succeeds even when React schedule lacks that dose', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd-new', amount: 2, time: '20:00' },
          ],
        }),
      ],
      logs: [],
    };
    reactMeds = [
      med({
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
      }),
    ];
    const { result } = mountHandlers();
    await act(async () => {
      result.current.handleConsumeDose('med-1', 'd-new');
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(durable.medications[0].currentPills).toBe(8);
    });
  });

  it('multi-dose without doseId yields missing_dose_id and no stock mutation', async () => {
    durable = {
      medications: [med({ currentPills: 10 })],
      logs: [],
    };
    reactMeds = [];
    const { result } = mountHandlers();
    await act(async () => {
      result.current.handleConsumeDose('med-1'); // no doseId
      await Promise.resolve();
      await Promise.resolve();
    });
    // No stock change
    expect(durable.medications[0].currentPills).toBe(10);
    expect(durable.logs).toHaveLength(0);
  });


  it('single-dose without doseId resolves to schedule dose and Takes', async () => {
    durable = {
      medications: [
        med({
          currentPills: 10,
          doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
        }),
      ],
      logs: [],
    };
    reactMeds = [];
    const { result } = mountHandlers();
    await act(async () => {
      result.current.handleConsumeDose('med-1'); // no doseId
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(durable.medications[0].currentPills).toBe(8);
    });
    expect(isDoseConsumedOnDate(durable.medications[0], 'd1', TODAY)).toBe(true);
  });

});
