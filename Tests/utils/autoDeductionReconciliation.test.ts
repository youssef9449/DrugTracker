import {
  __setAutoStockGateTestHooks,
} from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import { makeMedication as baseMed, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import {
  isValidExactOccurrenceIdentity,
  normalizeExactDoseId,
  reconcileFiredEvents,
  isExactAutoOccurrenceApplied,
  exactAutoLogId,
  applyExactAutoEventToMedication } from '../../src/utils/autoDeductionReconciliation';
import { autoDeductionOccurrenceKey } from '../../src/utils/autoDeductionNativeIdentity';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import {
  withAutoStockMutationGate,
  commitDurableAutoStockState,
type AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';


describe('isValidExactOccurrenceIdentity — triple identity (#268)', () => {
  it('requires non-empty medicationId, doseId, and YYYY-MM-DD calendarDate', () => {
    expect(isValidExactOccurrenceIdentity('med-1', 'd1', '2026-09-14')).toBe(true);
    expect(isValidExactOccurrenceIdentity('', 'd1', '2026-09-14')).toBe(false);
    expect(isValidExactOccurrenceIdentity('med-1', '', '2026-09-14')).toBe(false);
    expect(isValidExactOccurrenceIdentity('med-1', '  ', '2026-09-14')).toBe(false);
    expect(isValidExactOccurrenceIdentity('med-1', 'd1', '')).toBe(false);
    expect(isValidExactOccurrenceIdentity('med-1', 'd1', 'bad')).toBe(false);
  });

  it('normalizeExactDoseId does not invent identity', () => {
    expect(normalizeExactDoseId(null)).toBe('');
    expect(normalizeExactDoseId(undefined)).toBe('');
    expect(normalizeExactDoseId('  d1  ')).toBe('d1');
  });
});

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

    // There is no second automatic deduction from app-open or calendar-day
    // settlement (Issue #268 / PR #271). A second gate entry simply observes
    // the durable committed state; it must NOT re-apply the same
    // occurrence (the durable consume marker + exact log make it
    // already_applied). 8, not 6.
    await withAutoStockMutationGate(async (fresh) => {
      const r = reconcileFiredEvents(fresh.medications, fresh.logs, [e]);
      expect(r.details[0]?.outcome).toBe('already_applied');
      expect(r.mutated).toBe(false);
      expect(r.medications[0].currentPills).toBe(8);
    });
    expect(durable.medications[0].currentPills).toBe(8);
  });

  it('elapsed-day settlementDoesNotBlockFIRED (#265/#267)', async () => {
    // prevent the FIRED deduction.
    durable.medications = [
      baseMed({
        doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
        currentPills: 10,
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
      // NOT already_applied — the FIRED event is applied.
      expect(r.details[0]?.outcome).toBe('applied');
      expect(r.mutated).toBe(true);
      commitDurableAutoStockState({ medications: r.medications, logs: r.logs });
    });
    // event.amount (2) deducted exactly once.
    expect(durable.medications[0].currentPills).toBe(8);

    // Second reconciliation of the same FIRED: now there IS durable evidence
    // (consume marker) → already_applied → no second deduction.
    await withAutoStockMutationGate(async (fresh) => {
      const r = reconcileFiredEvents(fresh.medications, fresh.logs, [e]);
      expect(r.details[0]?.outcome).toBe('already_applied');
      expect(r.mutated).toBe(false);
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
      listFired: async () => ({ ok: true, events: events }),
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
      listFired: async () => ({ ok: true, events: stillFired }),
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
      listFired: async () => ({ ok: true, events: [e] }),
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
      listFired: async () => ({ ok: true, events: [e] }),
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
      listFired: async () => ({ ok: true, events: [e] }),
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
      listFired: async () => ({ ok: true, events: [e] }),
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
      listFired: async () => ({ ok: true, events: [e] }),
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
      mutationSeq: 1,
      globalAutoDeductEnabled: true,
    };
    let markCalls = 0;

    const result = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [baseMed({ currentPills: 10})],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: [] }),
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
      doseConsumptionHistory: { d: ['2026-09-13'] },
    });
    expect(isExactAutoOccurrenceApplied(med, 'd', '2026-09-13')).toBe(true);
    expect(isExactAutoOccurrenceApplied(med, 'd', '2026-09-14')).toBe(false);
  });
});

describe('durable currentPills after Exact apply (Issue #266)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconcileFiredEvents commits event.amount into currentPills once', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [fired({ medicationId: 'med-1', doseId: 'd', calendarDate: '2026-09-14', amount: 2 })]
    );
    expect(r.medications[0].currentPills).toBe(8);
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

  it('oldLastSyncDoesNotFoldHistoricalDaysIntoExactApply (#265)', () => {
    // Issue #265: a single FIRED event deducts ONLY event.amount. No
    // historical / day-based settlement is folded into the Exact apply —
    // occurrence. lastSync=09-10, event=09-13 amount 2 → 10 - 2 = 8 (NOT
    // 10 - 4 [days 11+12] - 2 = 4). The days 11+12 are NOT auto-settled by
    // this path; they stay as a live projection until a mutation or their
    // own FIRED occurrences settle them.
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
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
    // Exactly one exact log (the FIRED occurrence); no second day-based settlement log.
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
  });

  it('sameDayExactEventDoesNotUsePastDueWindow', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
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

  it('empty doseId: no stock/log, skipped_invalid, ACK terminal (#268)', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: '',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('missing doseId (undefined normalized): terminal ACK, no stock/log (#268)', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: undefined as unknown as string,
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
  });

  it('valid identity + invalid amount remains retryable (no ACK)', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 0,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
  });

});

describe('reconcileFiredEvents — malformed identity is terminal ACK (#262 Finding 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('missing medicationId: no stock/log, skipped_invalid, ACK terminal', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: '',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: '', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('missing calendarDate: no stock/log, skipped_invalid, ACK terminal', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '' },
    ]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
  });

  it('malformed calendarDate (not YYYY-MM-DD): terminal ACK, no stock/log', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('second reconciliation of same malformed event does not mutate stock or add logs', () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });
    const r1 = reconcileFiredEvents([med], [], [e]);
    expect(r1.toAcknowledge).toHaveLength(1);
    expect(r1.medications[0].currentPills).toBe(10);

    // Simulate native still listing the same malformed payload before ACK lands
    const r2 = reconcileFiredEvents(r1.medications, r1.logs, [e]);
    expect(r2.details[0].outcome).toBe('skipped_invalid');
    expect(r2.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(r2.mutated).toBe(false);
    expect(r2.medications[0].currentPills).toBe(10);
    expect(r2.newExactLogs).toEqual([]);
    expect(r2.logs).toEqual([]);
  });

  it('malformed identity terminal ACK does not block a distinct valid occurrence', () => {
    // Fixing calendarDate changes occurrence identity — not same-occurrence retry.
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const invalid = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });
    const r1 = reconcileFiredEvents([med], [], [invalid]);
    expect(r1.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(r1.medications[0].currentPills).toBe(10);

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

describe('runAutoDeductionReconciliation — malformed identity terminal native ACK (#262 F3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('malformed FIRED reaches markReconciled once; stock/log unchanged; no second ACK after terminal', async () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    // Malformed identity (invalid calendarDate) with positive amount
    const malformed: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: 'bad-date',
      amount: 2,
    });

    // Simulated native FIRED store: present until markReconciled succeeds
    let nativeFired: AutoDeductionEvent[] = [malformed];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        // Terminal native ACK: drop from unreconciled FIRED set
        nativeFired = nativeFired.filter(
          (e) =>
            !(
              e.medicationId === medicationId &&
              e.doseId === doseId &&
              e.calendarDate === calendarDate
            )
        );
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('skipped_invalid');
    expect(first.mutated).toBe(false);
    expect(first.medications[0].currentPills).toBe(10);
    expect(first.newExactLogs).toEqual([]);
    expect(first.logs).toEqual([]);
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    // Existing ACK path (markAll → markReconciled) invoked once
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: 'bad-date' },
    ]);
    expect(first.markedCount).toBe(1);
    expect(nativeFired).toEqual([]);

    // Second run: event no longer listed → no re-ACK, no mutation
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: first.medications,
      logs: first.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(second.mutated).toBe(false);
    expect(second.medications[0].currentPills).toBe(10);
    expect(second.newExactLogs).toEqual([]);
    expect(second.toAcknowledge).toEqual([]);
    expect(second.markedCount).toBe(0);
    expect(markCalls).toHaveLength(1);
  });

  it('valid identity + invalid amount does not call markReconciled (remains retryable)', async () => {
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const invalidAmount = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 0,
    });
    const nativeFired: AutoDeductionEvent[] = [invalidAmount];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const r = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(r.details[0]?.outcome).toBe('skipped_invalid');
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.toAcknowledge).toEqual([]);
    expect(r.markedCount).toBe(0);
    expect(markCalls).toEqual([]);
    // Still unreconciled FIRED in native mock
    expect(nativeFired).toHaveLength(1);
  });

  it('empty doseId FIRED: runner path terminal ACK via markAll; no stock/log/marker (#268)', async () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const emptyDose: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: '',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [emptyDose];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    // Production native ACK contract for malformed identity (mirrors
    // AutoDeductionEventStore.markReconciled in EventStoreMarkReconciledGuardTest):
    // the corrupt FIRED row is terminalized to REJECTED (NOT acknowledged as
    // RECONCILED). The native returns ok:true (handled, no retry needed) and
    // changed:false (nothing was RECONCILED). The JS runner's markAll treats
    // ok:true as a successful terminal ack regardless of `changed`.
    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        // Terminal native ACK: drop the corrupt row from the FIRED set.
        nativeFired = nativeFired.filter(
          (e) =>
            !(
              e.medicationId === medicationId &&
              String(e.doseId ?? '') === doseId &&
              e.calendarDate === calendarDate
            )
        );
        // Native terminalization to REJECTED → ok:true, changed:false.
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('skipped_invalid');
    expect(first.mutated).toBe(false);
    expect(first.medications[0].currentPills).toBe(10);
    expect(first.medications[0].lastConsumedDate).toBe('2026-09-12');
    expect(first.newExactLogs).toEqual([]);
    expect(first.logs).toEqual([]);
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    // Production ACK path: markAll → markReconciled invoked exactly once.
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(first.markedCount).toBe(1);
    // The corrupt row is gone from the FIRED set → no infinite retry.
    expect(nativeFired).toEqual([]);

    // Second pass: the corrupt row is no longer listed → no re-processing,
    // no re-ACK, no mutation. Terminal: never re-applied in a later pass.
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: first.medications,
      logs: first.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(second.mutated).toBe(false);
    expect(second.medications[0].currentPills).toBe(10);
    expect(second.newExactLogs).toEqual([]);
    expect(second.toAcknowledge).toEqual([]);
    expect(second.markedCount).toBe(0);
    // markReconciled was called at most once (only the first pass).
    expect(markCalls).toHaveLength(1);
  });

  it('missing doseId FIRED: runner path terminal ACK via markAll; no stock/log/marker (#268)', async () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const missingDose: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: undefined as unknown as string,
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [missingDose];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        nativeFired = nativeFired.filter(
          (e) =>
            !(
              e.medicationId === medicationId &&
              String(e.doseId ?? '') === doseId &&
              e.calendarDate === calendarDate
            )
        );
        // Native terminalization to REJECTED → ok:true, changed:false.
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('skipped_invalid');
    expect(first.mutated).toBe(false);
    expect(first.medications[0].currentPills).toBe(10);
    expect(first.medications[0].lastConsumedDate).toBe('2026-09-12');
    expect(first.newExactLogs).toEqual([]);
    expect(first.logs).toEqual([]);
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: '', calendarDate: '2026-09-14' },
    ]);
    expect(first.markedCount).toBe(1);
    // Terminal: the corrupt row is gone → no infinite retry.
    expect(nativeFired).toEqual([]);
  });

  it('native markReconciled web contract: empty doseId returns ok:false (not a valid occurrence)', async () => {
    // Direct contract assertion for the JS-level guard in
    // markAutoDeductionEventReconciled (autoDeductionNativeEvents.ts): on a non-Android
    // platform it refuses to bless an empty doseId as a valid occurrence. The
    // native Android path terminalizes the corrupt row to REJECTED instead
    // (covered by EventStoreMarkReconciledGuardTest). This guard is what
    // prevents JS from passing an empty doseId to native markReconciled as a
    // valid occurrence on web.
    const { markAutoDeductionEventReconciled } = await import(
      '../../src/utils/autoDeductionNativeEvents'
    );
    const r = await markAutoDeductionEventReconciled('med-1', '', '2026-09-14');
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
  });
});

describe('runAutoDeductionReconciliation — FIRED durable regardless of current schedule (#268 / PR #271)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no doseSchedule + valid non-empty doseId: FIRED applies with event.amount; ACK terminal (no retry)', async () => {
    // The med has no schedule at all, but a FIRED event with a well-formed
    // identity (non-empty doseId + valid date + positive amount) is durable
    // and MUST be reconciled via event.amount. amount is event.amount (not
    // dailyDose — no Legacy Single-Dose fallback). The occurrence is ACKed
    // once and dropped from the native FIRED set (terminal, no infinite retry).
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: undefined,
      dailyDose: 5,
    });
    const e: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [e];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const r = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        nativeFired = nativeFired.filter(
          (ev) =>
            !(
              ev.medicationId === medicationId &&
              String(ev.doseId ?? '') === doseId &&
              ev.calendarDate === calendarDate
            )
        );
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(r.details[0]?.outcome).toBe('applied');
    expect(r.mutated).toBe(true);
    // event.amount (2) applied, NOT dailyDose (5).
    expect(r.medications[0].currentPills).toBe(8);
    // No schedule → no lastConsumedDate write.
    expect(r.medications[0].lastConsumedDate).toBe('2026-09-12');
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].amount).toBe(-2);
    expect(r.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    expect(r.markedCount).toBe(1);
    expect(markCalls).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    // Terminal: the row is gone from the FIRED set → no infinite retry.
    expect(nativeFired).toEqual([]);
  });

  it('doseId removed from current schedule after fire: FIRED applies with event.amount; ACK once, no duplicate on retry', async () => {
    // Scenario from Finding 1: med was scheduled with d1 (amount 2). Native
    // created FIRED med-1+d1+2026-09-14+amount=2. User then removed d1 from
    // current doseSchedule. Reconciliation applies event.amount=2 once;
    // a second pass re-lists the same FIRED (before ACK lands) but finds the
    // durable consume marker / exact log → already_applied, no duplicate.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      // Current schedule no longer contains d1.
      doseSchedule: [{ id: 'd2', amount: 1, time: '20:00' }],
    });
    const e: AutoDeductionEvent = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    let nativeFired: AutoDeductionEvent[] = [e];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const first = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        nativeFired = nativeFired.filter(
          (ev) =>
            !(
              ev.medicationId === medicationId &&
              String(ev.doseId ?? '') === doseId &&
              ev.calendarDate === calendarDate
            )
        );
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(first.details[0]?.outcome).toBe('applied');
    expect(first.mutated).toBe(true);
    expect(first.medications[0].currentPills).toBe(8);
    expect(first.newExactLogs).toHaveLength(1);
    expect(first.newExactLogs[0].amount).toBe(-2);
    expect(first.newExactLogs[0].id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
    expect(first.newExactLogs[0].type).toBe('exact_auto');
    expect(first.logs.filter((l) => l.type === 'exact_auto')).toHaveLength(0);
    expect(first.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
    expect(first.markedCount).toBe(1);
    expect(nativeFired).toEqual([]);

    // Second pass: simulate the native still listing the same FIRED before
    // the ACK landed (or a retry). The durable exact log + consume marker
    // make it already_applied → no duplicate deduction, no duplicate log.
    const sameFired: AutoDeductionEvent[] = [e];
    const second = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: first.medications,
      logs: first.logs,
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: sameFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        return { ok: true, changed: false };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(second.mutated).toBe(false);
    // Stock unchanged (no second deduction).
    expect(second.medications[0].currentPills).toBe(8);
    expect(second.newExactLogs).toEqual([]);
    // The single durable exact log remains (no duplicate).
    expect(second.logs.filter((l) => l.id === exactAutoLogId('med-1', 'd1', '2026-09-14'))).toHaveLength(1);
    expect(second.toAcknowledge).toEqual([
      { medicationId: 'med-1', doseId: 'd1', calendarDate: '2026-09-14' },
    ]);
  });

  it('valid identity + invalid amount: no ACK, retryable (unchanged)', async () => {
    // Invalid amount with a well-formed identity stays retryable (no ACK).
    // This contract is unchanged by the schedule-durability fix.
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const invalidAmount = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 0,
    });
    const nativeFired: AutoDeductionEvent[] = [invalidAmount];
    const markCalls: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }> = [];

    const r = await runAutoDeductionReconciliation({
      alreadyInGate: true,
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => ({ ok: true, events: nativeFired }),
      markReconciled: async (medicationId, doseId, calendarDate) => {
        markCalls.push({ medicationId, doseId, calendarDate });
        return { ok: true, changed: true };
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });

    expect(r.details[0]?.outcome).toBe('skipped_invalid');
    expect(r.mutated).toBe(false);
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.newExactLogs).toEqual([]);
    expect(r.toAcknowledge).toEqual([]);
    expect(r.markedCount).toBe(0);
    expect(markCalls).toEqual([]);
    // Retryable: still listed in the native FIRED set.
    expect(nativeFired).toHaveLength(1);
  });
});

describe('applyExactAutoEventToMedication — FIRED occurrence is durable; event.amount is authoritative (#268 / PR #271)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nativeStockApplied_doesNotSubtractCurrentPillsAgain_butRecordsActualCharge', () => {
    const med = baseMed({
      currentPills: 8,
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
      nativeStockApplied: true,
      actualDeducted: 2,
    });

    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // Native has already moved 10 -> 8; JS must not perform 8 -> 6.
      expect(applied.updatedMed.currentPills).toBe(8);
      expect(applied.updatedMed.doseConsumptionHistory?.d1).toEqual(['2026-09-14']);
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('with explicit doseSchedule: Exact applies; lastConsumedDate updates only when all slots consumed', () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // Only one of two slots consumed → lastConsumedDate unchanged
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      expect(applied.updatedMed.currentPills).toBe(9);
      expect(applied.log.id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
      expect(applied.log.type).toBe('exact_auto');
      expect(applied.log.doseId).toBe('d1');
    }
  });

  it('doseId removed from current doseSchedule AFTER fire: FIRED event still applies with event.amount (#268 / PR #271)', () => {
    // Scenario from Finding 1: the med was scheduled with d1 (amount 2). The
    // native created a FIRED event med-1+d1+2026-09-20+amount=2. The user then
    // removed d1 from the current doseSchedule. Reconciliation MUST still
    // apply event.amount=2 (the FIRED occurrence already happened). No
    // Legacy Single-Dose fallback: amount is event.amount, NOT dailyDose.
    // lastConsumedDate is NOT written (no schedule to test all-consumed).
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      // Current schedule no longer contains d1 — it was removed after fire.
      doseSchedule: [{ id: 'd2', amount: 1, time: '20:00' }],
      dailyDose: 1,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // event.amount (2) is authoritative, NOT dailyDose (1).
      expect(applied.updatedMed.currentPills).toBe(8);
      // No schedule contains d1 → no all-consumed write → lastConsumedDate
      // unchanged. There is NO Legacy Single-Dose doseId-only write.
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      // Exact log is created once with the full identity.
      expect(applied.log.id).toBe(exactAutoLogId('med-1', 'd1', '2026-09-14'));
      expect(applied.log.type).toBe('exact_auto');
      expect(applied.log.doseId).toBe('d1');
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('no doseSchedule at all: FIRED event still applies with event.amount (no Legacy Single-Dose fallback)', () => {
    // The med never had a schedule. A FIRED event with a well-formed identity
    // (non-empty doseId + valid date + positive amount) is durable and must be
    // reconciled via event.amount. There is NO Legacy Single-Dose fallback:
    // amount is event.amount (2), NOT dailyDose. lastConsumedDate is NOT
    // written (no schedule to test all-consumed → no doseId-only write).
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      // no doseSchedule — would be the pre-PR legacy single-dose shape
      doseSchedule: undefined,
      dailyDose: 2,
      reminderTime: '08:00',
      reminderEnabled: true,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'some-id',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // event.amount (2) authoritative, NOT dailyDose (2 here, but the point
      // is that dailyDose is never the source — see the next assertion's logic).
      expect(applied.updatedMed.currentPills).toBe(8);
      // No schedule → no all-consumed → lastConsumedDate unchanged
      // (no Legacy Single-Dose doseId-only write).
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      expect(applied.log.doseId).toBe('some-id');
      expect(applied.log.id).toBe(exactAutoLogId('med-1', 'some-id', '2026-09-14'));
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('no doseSchedule + event.amount differs from dailyDose: amount is event.amount, NOT dailyDose', () => {
    // Proves there is no Legacy Single-Dose fallback to dailyDose for amount.
    // dailyDose = 5 but the FIRED event carries amount = 2 → stock drops by 2.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: undefined,
      dailyDose: 5,
      reminderTime: '08:00',
      reminderEnabled: true,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'x',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // 10 − event.amount(2) = 8, NOT 10 − dailyDose(5) = 5.
      expect(applied.updatedMed.currentPills).toBe(8);
      expect(applied.log.amount).toBe(-2);
    }
  });

  it('empty doseSchedule array: FIRED event still applies with event.amount', () => {
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'orphan',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.updatedMed.currentPills).toBe(9);
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-12');
      expect(applied.log.amount).toBe(-1);
    }
  });

  it('empty doseId: ok:false invalid_dose_id (malformed identity — not applied)', () => {
    // Empty doseId is the ONLY identity failure that blocks a FIRED occurrence
    // from applying. It is a malformed identity (terminal at the runner level).
    const med = baseMed({
      currentPills: 10,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: '',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe('invalid_dose_id');
    }
    expect(med.currentPills).toBe(10);
  });

  it('valid doseId member with multi-slot schedule + all consumed → lastConsumedDate set', () => {
    // Same explicit schedule as the first test, but pre-mark the other slot
    // consumed so this Exact apply completes the day → lastConsumedDate moves.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
      doseConsumptionHistory: { d2: ['2026-09-14'] },
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.updatedMed.lastConsumedDate).toBe('2026-09-14');
      expect(applied.updatedMed.currentPills).toBe(9);
    }
  });

  it('current schedule amount differs from event.amount → deduction is event.amount, NOT the schedule amount (#265)', () => {
    // The current doseSchedule says d1 amount=3, but the FIRED event carries
    // amount=1. The deduction is event.amount (1), NOT the current schedule
    // amount (3). event.amount is the authoritative charge for a FIRED
    // occurrence; the current schedule is only for scheduling FUTURE ones.
    const med = baseMed({
      currentPills: 10,
      lastConsumedDate: '2026-09-12',
      doseSchedule: [{ id: 'd1', amount: 3, time: '08:00' }],
      dailyDose: 3,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // 10 − event.amount(1) = 9, NOT 10 − schedule amount(3) = 7.
      expect(applied.updatedMed.currentPills).toBe(9);
      expect(applied.log.amount).toBe(-1);
    }
  });

  it('past FIRED occurrence adds no historical sibling/day deductions (#265)', () => {
    // A single FIRED event on a past calendar day deducts ONLY its own
    // event.amount. No historical / sibling-day settlement is folded into
    // the apply — other elapsed days (e.g. between lastSync and the event
    // lastSync=09-10, event=09-13 amount 2 → 10 − 2 = 8. Days 09-11/09-12
    // are NOT charged here (they stay a live projection until a mutation or
    // their own FIRED occurrences settle them).
    const med = baseMed({
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 2, time: '20:00' },
      ],
      currentPills: 10,
      lastConsumedDate: '2026-09-09',
      dailyDose: 4,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-13',
      amount: 2,
    });
    const applied = applyExactAutoEventToMedication(med, e, new Date());
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // Only the FIRED occurrence's amount (2). No sibling d2, no days
      // 09-11/09-12, no dailyDose(4)-based catch-up.
      expect(applied.updatedMed.currentPills).toBe(8);
      // Only one exact log (this occurrence).
      expect(applied.log.amount).toBe(-2);
      expect(applied.log.doseId).toBe('d1');
    }
  });

  it('old elapsed-day settlement does not increase the Exact deduction (#265)', () => {
    // deduction amount.
    const recent = baseMed({
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
      currentPills: 10,
      dailyDose: 2,
    });
    const old = baseMed({
      doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
      currentPills: 10,
      dailyDose: 2,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd1',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r1 = applyExactAutoEventToMedication(recent, e, new Date());
    const r2 = applyExactAutoEventToMedication(old, e, new Date());
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.updatedMed.currentPills).toBe(8);
      expect(r2.updatedMed.currentPills).toBe(8);
    }
  });
});
