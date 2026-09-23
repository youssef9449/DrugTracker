
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import { makeMedication as baseMed, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { reconcileFiredEvents, isExactAutoOccurrenceApplied, exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';

import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';




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
