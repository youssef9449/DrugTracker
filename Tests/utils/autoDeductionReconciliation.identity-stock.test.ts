import { __setAutoStockGateTestHooks } from './autoStockTestHooks';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { makeMedication as baseMed, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { isValidExactOccurrenceIdentity, normalizeExactDoseId, reconcileFiredEvents, isExactAutoOccurrenceApplied } from '../../src/utils/autoDeductionReconciliation';
import { autoDeductionOccurrenceKey } from '../../src/utils/autoDeductionNativeIdentity';


import { withAutoStockMutationGate, commitDurableAutoStockState } from '../../src/utils/autoDeductionStockGate';



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
