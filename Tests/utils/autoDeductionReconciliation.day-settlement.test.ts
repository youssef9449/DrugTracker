
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMedication as baseMed, makeAutoDeductionEvent as fired } from '../fixtures/testFixtures';
import { reconcileFiredEvents, isExactAutoOccurrenceApplied } from '../../src/utils/autoDeductionReconciliation';





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
