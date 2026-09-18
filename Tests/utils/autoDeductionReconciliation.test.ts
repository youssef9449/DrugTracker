import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import {
  reconcileFiredEvents,
  isExactAutoOccurrenceApplied,
  exactAutoLogId,
} from '../../src/utils/autoDeductionReconciliation';
import { autoDeductionOccurrenceKey } from '../../src/utils/autoDeductionNative';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import {
  withAutoStockMutationGate,
  commitDurableAutoStockState,
  __setAutoStockGateTestHooks,
  type AutoStockDurableState,
} from '../../src/utils/autoDeductionStockGate';
import {
  syncAutoDailyDeductions,
  effectiveCurrentPills,
} from '../../src/utils/dateCalculations';

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

function fired(
  over: Partial<AutoDeductionEvent> &
    Pick<AutoDeductionEvent, 'medicationId' | 'doseId' | 'calendarDate' | 'amount'>
): AutoDeductionEvent {
  return {
    scheduledAtEpochMs: 1,
    status: 'FIRED',
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
    ...over,
  };
}

describe('identity', () => {
  it('same med+dose+date key; dose and date isolation', () => {
    expect(autoDeductionOccurrenceKey('m', 'd', '2026-09-14')).toBe(
      autoDeductionOccurrenceKey('m', 'd', '2026-09-14')
    );
    expect(autoDeductionOccurrenceKey('m', 'd1', '2026-09-14')).not.toBe(
      autoDeductionOccurrenceKey('m', 'd2', '2026-09-14')
    );
  });
});

describe('stock gate — fresh durable state', () => {
  let durable: AutoStockDurableState;

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    vi.useRealTimers();
  });

  beforeEach(() => {
    // Pin calendar so lastSync / event dates are independent of machine clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));

    durable = {
      medications: [
        baseMed({
          doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
          currentPills: 10,
          lastSyncDate: '2026-09-13',
        }),
      ],
      logs: [],
    };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: [...durable.logs],
      }),
      commit: (state) => {
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: [...state.logs],
        };
        return null;
      },
    });
  });

  it('usesFreshDurableStateInsideGate', async () => {
    await withAutoStockMutationGate((fresh) => {
      expect(fresh.medications[0].currentPills).toBe(10);
      const next = {
        ...fresh.medications[0],
        currentPills: 8,
      };
      commitDurableAutoStockState({ medications: [next], logs: fresh.logs });
    });
    expect(durable.medications[0].currentPills).toBe(8);

    // Second entry must see 8, not a stale 10
    await withAutoStockMutationGate((fresh) => {
      expect(fresh.medications[0].currentPills).toBe(8);
    });
  });

  it('staleSnapshotsCannotOverwriteCommittedState', async () => {
    const staleReactSnapshot = 10; // ignored — gate does not use it
    await withAutoStockMutationGate((fresh) => {
      expect(fresh.medications[0].currentPills).toBe(staleReactSnapshot);
      commitDurableAutoStockState({
        medications: [{ ...fresh.medications[0], currentPills: 8 }],
        logs: [],
      });
    });
    await withAutoStockMutationGate((fresh) => {
      // Even if caller still "thinks" 10, durable is 8
      expect(fresh.medications[0].currentPills).toBe(8);
      // Attempting to re-apply same logical -2 from stale 10 would be wrong;
      // here we just assert second op sees 8
    });
    expect(durable.medications[0].currentPills).toBe(8);
  });

  it('nativeThenLegacyDoesNotDoubleDeduct', async () => {
    // Scenario B (native-first): lastSync has NOT yet settled the event day.
    // today=2026-09-14 (pinned), lastSync=2026-09-12, event=2026-09-13 amount=2.
    durable.medications = [
      baseMed({
        doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
        currentPills: 10,
        lastSyncDate: '2026-09-12',
        dailyDose: 2,
      }),
    ];
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-13',
      amount: 2,
    });

    await withAutoStockMutationGate(async (fresh) => {
      const r = reconcileFiredEvents(fresh.medications, fresh.logs, [e]);
      expect(r.details[0]?.outcome).toBe('applied');
      commitDurableAutoStockState({ medications: r.medications, logs: r.logs });
    });
    expect(durable.medications[0].currentPills).toBe(8);
    expect(isExactAutoOccurrenceApplied(durable.medications[0], 'd', '2026-09-13')).toBe(true);

    await withAutoStockMutationGate((fresh) => {
      const sync = syncAutoDailyDeductions(fresh.medications, '2026-09-14');
      commitDurableAutoStockState({
        medications: sync.updatedMeds,
        logs: [...sync.newLogs, ...fresh.logs],
      });
    });
    // Same occurrence must not be charged again (8, not 6)
    expect(durable.medications[0].currentPills).toBe(8);
  });

  it('legacyThenNativeDoesNotDoubleDeduct', async () => {
    // Scenario A: legacy day settlement already advanced lastSync over the event day.
    // today=2026-09-14, lastSync=2026-09-13, event=2026-09-13 → already reflected.
    durable.medications = [
      baseMed({
        doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
        currentPills: 8,
        lastSyncDate: '2026-09-13',
        dailyDose: 2,
      }),
    ];
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-13',
      amount: 2,
    });
    await withAutoStockMutationGate(async (fresh) => {
      const r = reconcileFiredEvents(fresh.medications, fresh.logs, [e]);
      expect(r.details[0]?.outcome).toBe('already_applied');
      commitDurableAutoStockState({ medications: r.medications, logs: r.logs });
    });
    expect(durable.medications[0].currentPills).toBe(8);
  });

  it('twoExactEventsSerializeCorrectly', async () => {
    durable.medications = [
      baseMed({
        doseSchedule: [
          { id: 'a', amount: 1, time: '08:00' },
          { id: 'b', amount: 2, time: '14:00' },
        ],
        currentPills: 10,
        lastSyncDate: '2026-09-14',
      }),
    ];
    const events = [
      fired({
        medicationId: 'med-1',
        doseId: 'a',
        calendarDate: '2026-09-14',
        amount: 1,
        scheduledAtEpochMs: 1,
      }),
      fired({
        medicationId: 'med-1',
        doseId: 'b',
        calendarDate: '2026-09-14',
        amount: 2,
        scheduledAtEpochMs: 2,
      }),
    ];
    // Two concurrent-looking calls — serialized by gate
    const p1 = withAutoStockMutationGate((fresh) => {
      const r = reconcileFiredEvents(fresh.medications, fresh.logs, [events[0]]);
      commitDurableAutoStockState({ medications: r.medications, logs: r.logs });
      return r.medications[0].currentPills;
    });
    const p2 = withAutoStockMutationGate((fresh) => {
      const r = reconcileFiredEvents(fresh.medications, fresh.logs, [events[1]]);
      commitDurableAutoStockState({ medications: r.medications, logs: r.logs });
      return r.medications[0].currentPills;
    });
    await Promise.all([p1, p2]);
    expect(durable.medications[0].currentPills).toBe(7);
  });
});

describe('BLOCKER 2 — partial native acknowledgement', () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('partialNativeAcknowledgementIsRecoverable', async () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
      ],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
    });
    const events = [
      fired({
        medicationId: 'med-1',
        doseId: 'a',
        calendarDate: '2026-09-14',
        amount: 1,
        scheduledAtEpochMs: 1,
      }),
      fired({
        medicationId: 'med-1',
        doseId: 'b',
        calendarDate: '2026-09-14',
        amount: 2,
        scheduledAtEpochMs: 2,
      }),
    ];
    let medsStore: Medication[] = [med];
    let logsStore: ConsumptionLog[] = [];
    let envelope: unknown = null;
    const marked = new Set<string>();
    let failB = true;

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => events,
      markReconciled: async (_medicationId, doseId, _calendarDate) => {
        const k = `${doseId}`;
        if (k === 'b' && failB) return { ok: false, changed: false };
        marked.add(k);
        return { ok: true, changed: true };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => envelope as never,
      saveEnvelope: (env) => {
        envelope = env;
        return null;
      },
    });
    expect(first.medications[0].currentPills).toBe(7);
    expect(first.partialNativeAck).toBe(true);
    expect(marked.has('a')).toBe(true);
    // Envelope cleared under Option B after JS commit
    expect(envelope).toBeNull();

    // Restart: B still FIRED; JS markers prevent second deduct
    failB = false;
    const stillFired = events.filter((e) => !marked.has(e.doseId));
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => stillFired,
      markReconciled: async (_m, doseId) => {
        marked.add(doseId);
        return { ok: true, changed: true };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(second.details.every((d) => d.outcome === 'already_applied')).toBe(true);
    expect(second.medications[0].currentPills).toBe(7);
    expect(logsStore.filter((l) => l.id.startsWith('exact-auto:')).length).toBe(2);
    expect(marked.has('b')).toBe(true);
  });

  it('markFailureDoesNotCauseSecondDeduction', async () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let medsStore = [med];
    let logsStore: ConsumptionLog[] = [];
    await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        return { ok: false, changed: false };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(medsStore[0].currentPills).toBe(8);
    const retry = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => ({ ok: true, changed: true }),
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(retry.details[0].outcome).toBe('already_applied');
    expect(retry.medications[0].currentPills).toBe(8);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
  });

  it('resolvedPromiseWithOkFalseIsAcknowledgementFailure', async () => {
    // Resolved Promise + ok=false must be treated as failure (not throw).
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let medsStore = [med];
    let logsStore: ConsumptionLog[] = [];
    let markCalls = 0;

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        markCalls += 1;
        return { ok: false, changed: false };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.medications[0].currentPills).toBe(8);
    expect(first.partialNativeAck).toBe(true);
    expect(first.markedCount).toBe(0);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
    expect(markCalls).toBe(1);

    // Retry: markers prove already applied; no second stock/log; ack succeeds
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        markCalls += 1;
        return { ok: true, changed: true };
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(second.details[0].outcome).toBe('already_applied');
    expect(second.medications[0].currentPills).toBe(8);
    expect(second.partialNativeAck).toBe(false);
    expect(second.markedCount).toBe(1);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
    expect(markCalls).toBe(2);
  });

  it('alreadyReconciledOkTrueChangedFalseIsSuccessfulTerminalAck', async () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let medsStore = [med];
    let logsStore: ConsumptionLog[] = [];

    const result = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: medsStore,
      logs: logsStore,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => ({ ok: true, changed: false }),
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(result.medications[0].currentPills).toBe(8);
    expect(result.partialNativeAck).toBe(false);
    expect(result.markedCount).toBe(1);
    expect(logsStore.filter((l) => l.id === exactAutoLogId('med-1', 'd', '2026-09-14')).length).toBe(
      1
    );
  });

  it('envelopePersistenceFailureDoesNotSetPartialNativeAck', async () => {
    // Envelope present + JS recovery persist fails → recoveredEnvelope true,
    // but no markReconciled attempt occurred, so partialNativeAck must be false.
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 8,
      lastSyncDate: '2026-09-14',
    });
    const envelope = {
      version: 1 as const,
      status: 'js_ready' as const,
      medications: [med],
      logs: [],
      toAcknowledge: [
        { medicationId: 'med-1', doseId: 'd', calendarDate: '2026-09-14' },
      ],
      createdAt: '2026-09-14T12:00:00.000Z',
    };
    let markCalls = 0;

    const result = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [baseMed({ currentPills: 10, lastSyncDate: '2026-09-14' })],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => [],
      markReconciled: async () => {
        markCalls += 1;
        return { ok: true, changed: true };
      },
      persistMeds: () => 'persist_failed',
      persistLogs: () => null,
      loadEnvelope: () => envelope as never,
      saveEnvelope: () => null,
    });

    expect(result.recoveredEnvelope).toBe(true);
    expect(result.partialNativeAck).toBe(false);
    expect(result.markedCount).toBe(0);
    expect(markCalls).toBe(0);
  });
});

describe('multi-dose', () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exactAmountIsUsed and siblingDoseIsIndependent', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
        { id: 'c', amount: 1, time: '22:00' },
      ],
      dailyDose: 4,
      currentPills: 20,
      lastSyncDate: '2026-09-14',
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [fired({ medicationId: 'med-1', doseId: 'b', calendarDate: '2026-09-14', amount: 2 })]
    );
    expect(r.medications[0].currentPills).toBe(18);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'b', '2026-09-14')).toBe(true);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'a', '2026-09-14')).toBe(false);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'c', '2026-09-14')).toBe(false);
  });

  it('siblingDateIsIndependent', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
      doseConsumptionHistory: { d: ['2026-09-13'] },
      doseConsumption: { d: '2026-09-13' },
    });
    expect(isExactAutoOccurrenceApplied(med, 'd', '2026-09-13')).toBe(true);
    expect(isExactAutoOccurrenceApplied(med, 'd', '2026-09-14')).toBe(false);
  });
});

describe('projection', () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('effectiveCurrentPillsMatchesCommittedSnapshot', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [fired({ medicationId: 'med-1', doseId: 'd', calendarDate: '2026-09-14', amount: 2 })]
    );
    expect(r.medications[0].currentPills).toBe(8);
    const eff = effectiveCurrentPills(
      r.medications[0],
      '2026-09-14',
      new Date('2026-09-14T20:00:00')
    );
    expect(eff).toBe(8);
  });
});

describe('deterministicLogPreventsDuplicate', () => {

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('duplicate FIRED → one log', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 5,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const r = reconcileFiredEvents([med], [], [e, e]);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.medications[0].currentPills).toBe(4);
  });
});

describe('exact event day must not be double-settled', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exactEventOnPastUnsettledDayDoesNotDoubleDeduct', () => {
    // lastSync=09-12, event=09-13 amount 2, current=10 → 8 (not 6)
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-12',
      dailyDose: 2,
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [
        fired({
          medicationId: 'med-1',
          doseId: 'd',
          calendarDate: '2026-09-13',
          amount: 2,
        }),
      ]
    );
    expect(r.details[0].outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(8);
  });

  it('partialMultiDoseDayDoesNotDeductSibling', () => {
    // morning only on historical day — evening must remain uncharged
    const med = baseMed({
      doseSchedule: [
        { id: 'morning', amount: 2, time: '08:00' },
        { id: 'evening', amount: 3, time: '20:00' },
      ],
      currentPills: 10,
      lastSyncDate: '2026-09-12',
      dailyDose: 5,
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [
        fired({
          medicationId: 'med-1',
          doseId: 'morning',
          calendarDate: '2026-09-13',
          amount: 2,
          scheduledAtEpochMs: 1,
        }),
      ]
    );
    expect(r.medications[0].currentPills).toBe(8);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'morning', '2026-09-13')).toBe(
      true
    );
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'evening', '2026-09-13')).toBe(
      false
    );
  });

  it('twoEventsOnSameHistoricalDayDeductOnlyTheirOwnAmounts', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'morning', amount: 2, time: '08:00' },
        { id: 'evening', amount: 3, time: '20:00' },
      ],
      currentPills: 10,
      lastSyncDate: '2026-09-12',
      dailyDose: 5,
    });
    const events = [
      fired({
        medicationId: 'med-1',
        doseId: 'morning',
        calendarDate: '2026-09-13',
        amount: 2,
        scheduledAtEpochMs: 100,
      }),
      fired({
        medicationId: 'med-1',
        doseId: 'evening',
        calendarDate: '2026-09-13',
        amount: 3,
        scheduledAtEpochMs: 200,
      }),
    ];
    const r = reconcileFiredEvents([med], [], events);
    expect(r.medications[0].currentPills).toBe(5);
    expect(r.newExactLogs).toHaveLength(2);
  });

  it('priorHistoricalDaysBeforeEventDayStillSettle', () => {
    // lastSync=09-10, event=09-13 amount 2; days 11+12 still due (2 each) → 10-4-2=4
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-10',
      dailyDose: 2,
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [
        fired({
          medicationId: 'med-1',
          doseId: 'd',
          calendarDate: '2026-09-13',
          amount: 2,
        }),
      ]
    );
    expect(r.medications[0].currentPills).toBe(4);
  });

  it('sameDayExactEventDoesNotUsePastDueWindow', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
      dailyDose: 2,
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [
        fired({
          medicationId: 'med-1',
          doseId: 'd',
          calendarDate: '2026-09-14',
          amount: 2,
        }),
      ]
    );
    expect(r.medications[0].currentPills).toBe(8);
  });

  it('duplicateExactOccurrenceIsIdempotent', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-12',
      dailyDose: 2,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-13',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e, e]);
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.newExactLogs).toHaveLength(1);
  });


  it('FIRED still reconciles when global auto-deduct is disabled', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
      dailyDose: 1,
      autoDeductEnabled: true,
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [
        fired({
          medicationId: 'med-1',
          doseId: 'd',
          calendarDate: '2026-09-14',
          amount: 2,
        }),
      ],
      { globalAutoDeductEnabled: false }
    );
    expect(r.details[0].outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(8);
    expect(r.toAcknowledge).toHaveLength(1);
  });

  it('FIRED still reconciles when medication auto-deduct is disabled', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
      dailyDose: 1,
      autoDeductEnabled: false,
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [
        fired({
          medicationId: 'med-1',
          doseId: 'd',
          calendarDate: '2026-09-14',
          amount: 2,
        }),
      ],
      { globalAutoDeductEnabled: true }
    );
    expect(r.details[0].outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(8);
  });

  it('repeated reconciliation remains idempotent after apply', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
      dailyDose: 1,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r1 = reconcileFiredEvents([med], [], [e]);
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e]);
    expect(r1.medications[0].currentPills).toBe(8);
    expect(r2.medications[0].currentPills).toBe(8);
    expect(r2.details[0].outcome).toBe('already_applied');
  });

});

describe('reconcileFiredEvents — invalid amount must not ACK', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('amount <= 0 / NaN / Infinity → skipped_invalid, empty toAcknowledge, no stock/log', () => {
    const med = baseMed({
      currentPills: 10,
      lastSyncDate: '2026-09-13',
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = fired({
        medicationId: 'med-1',
        doseId: 'd1',
        calendarDate: '2026-09-14',
        amount,
      });
      const r = reconcileFiredEvents([med], [], [e]);
      expect(r.details).toEqual([
        expect.objectContaining({
          medicationId: 'med-1',
          doseId: 'd1',
          calendarDate: '2026-09-14',
          outcome: 'skipped_invalid',
        }),
      ]);
      expect(r.toAcknowledge).toEqual([]);
      expect(r.mutated).toBe(false);
      expect(r.medications[0].currentPills).toBe(10);
      expect(r.newExactLogs).toEqual([]);
      expect(r.logs).toEqual([]);
    }
  });

  it('invalid then valid amount on same occurrence: no ACK first, applied + ACK second', () => {
    const med = baseMed({
      currentPills: 10,
      lastSyncDate: '2026-09-13',
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const invalid = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 0,
    });
    const r1 = reconcileFiredEvents([med], [], [invalid]);
    expect(r1.details[0].outcome).toBe('skipped_invalid');
    expect(r1.toAcknowledge).toEqual([]);
    expect(r1.medications[0].currentPills).toBe(10);
    expect(r1.newExactLogs).toEqual([]);

    const valid = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [valid]);
    expect(r2.details[0].outcome).toBe('applied');
    expect(r2.mutated).toBe(true);
    expect(r2.medications[0].currentPills).toBe(8);
    expect(r2.newExactLogs).toHaveLength(1);
    expect(r2.newExactLogs[0].amount).toBe(-2);
    expect(r2.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
  });
});
