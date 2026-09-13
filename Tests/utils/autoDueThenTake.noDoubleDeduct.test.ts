/**
 * Regression: auto-due + Take from alarm / push must never double-deduct
 * the same dose identity (medicationId + doseId + date).
 *
 * Production wiring (unchanged by this file):
 *   Push: localNotificationActionPerformed → registerNotificationActionHandler
 *         → actionId 'take_dose' → handleTakeDoseFromAlarm(med, doseId)
 *         → consumeDose(med, 'alarm', today, now, doseId)
 *   In-app: DoseAlarmModal onTakeDose → same handleTakeDoseFromAlarm
 *
 * Architecture (gated multi-dose — always gated when doseSchedule exists):
 *   - syncAutoDailyDeductions settles ONLY fully-elapsed **past** days
 *     (pastDueUnits). Today's slots stay dynamic projection via
 *     effectiveCurrentPills / todayDueUnits until consumeDose settles them.
 *   - Therefore "actual auto snapshot settlement of **today's** d1, then
 *     same-day Take of d1" is **impossible by design** — not a missing
 *     test, a production boundary. Same-day due is projection-only.
 *   - Actual auto settlement CAN occur for historical past days; Take
 *     always targets **today's** identity, so it must not re-apply past
 *     auto units and must not invent a second charge for today's slot.
 *
 * Scenario (product request):
 *   med-1: d1@08:00 amount 1, d2@20:00 amount 2
 *   now = 09:00 → d1 elapsed/due (projection), d2 still future
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  syncAutoDailyDeductions,
  computeDueDoseBreakdown,
  isDoseConsumedOnDate,
  todayDueUnits,
} from '@/utils/dateCalculations';
import { consumeDose } from '@/utils/medActions';
import type { Medication, ConsumptionLog } from '@/types';

const TODAY = '2024-09-12';
const YESTERDAY = '2024-09-11';
const NOW_AFTER_D1 = new Date('2024-09-12T09:00:00');

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TODAY,
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '08:00',
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 2, time: '20:00' },
    ],
    dosesPerDay: 2,
    ...overrides,
  };
}

/** Snapshot of identity-relevant fields for second-Take no-mutation checks. */
function identitySnapshot(med: Medication) {
  return {
    currentPills: med.currentPills,
    lastSyncDate: med.lastSyncDate,
    lastConsumedDate: med.lastConsumedDate,
    doseConsumption: { ...(med.doseConsumption ?? {}) },
    doseConsumptionHistory: JSON.parse(
      JSON.stringify(med.doseConsumptionHistory ?? {})
    ) as Record<string, string[]>,
    doseSkippedHistory: JSON.parse(
      JSON.stringify(med.doseSkippedHistory ?? {})
    ) as Record<string, string[]>,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Architecture boundary: same-day multi is projection-only', () => {
  it('syncAutoDailyDeductions does NOT settle today d1 into currentPills (gated multi)', () => {
    // Documents why "actual auto-deduct of today's d1 then Take" cannot
    // occur: dueUnits for gated = pastDueUnits only; same-day lastSync
    // → betweenDays 0 → no snapshot change.
    const med = makeMed({ currentPills: 30, lastSyncDate: TODAY });
    const now = NOW_AFTER_D1;

    const before = computeDueDoseBreakdown(med, now, TODAY);
    expect(before.gated).toBe(true);
    expect(before.todayDueUnits).toBe(1);
    expect(before.pastDueUnits).toBe(0);
    expect(before.fullDueUnits).toBe(1);
    expect(med.currentPills).toBe(30);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(29);

    const sync = syncAutoDailyDeductions([med], TODAY, now);
    expect(sync.newLogs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    expect(sync.updatedMeds[0]!.currentPills).toBe(30); // snapshot unchanged
    expect(effectiveCurrentPills(sync.updatedMeds[0]!, TODAY, now)).toBe(29);
    expect(isDoseConsumedOnDate(sync.updatedMeds[0]!, 'd1', TODAY)).toBe(false);
  });
});

describe('A — Today projection path: auto-due + Take (alarm) — one deduction', () => {
  it('Case 1: d1 elapsed (projected due) then alarm Take deducts once only', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    // Pre: projection only — snapshot vs effective diverge by d1 amount.
    expect(med.currentPills).toBe(30);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(29);
    expect(todayDueUnits(med, now, TODAY)).toBe(1);
    expect(isDoseConsumedOnDate(med, 'd1', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(false);

    const take = consumeDose(med, 'alarm', TODAY, now, 'd1');

    expect(take.reason).toBeUndefined();
    expect(take.doseAmount).toBe(1);
    expect(take.updatedMed).not.toBeNull();
    expect(take.log).not.toBeNull();
    expect(take.log!.type).toBe('dose_taken');
    expect(take.log!.doseId).toBe('d1');
    expect(take.log!.medicationId).toBe('med-1');
    expect(take.log!.date).toBe(TODAY);
    expect(take.log!.amount).toBe(-1);
    expect(take.log!.description).toContain('من التنبيه');

    const after = take.updatedMed!;
    // Transition: snapshot moved 30 → 29 (settled d1 once).
    expect(after.currentPills).toBe(29);
    expect(after.doseConsumption?.d1).toBe(TODAY);
    expect(after.doseConsumption?.d2).toBeUndefined();
    expect(isDoseConsumedOnDate(after, 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(after, 'd2', TODAY)).toBe(false);

    // After settle, snapshot === effective (no remaining today projection for d1).
    expect(effectiveCurrentPills(after, TODAY, now)).toBe(29);
    expect(todayDueUnits(after, now, TODAY)).toBe(0);

    // Accounting: exactly one dose_taken unit of -1 for this identity.
    expect(take.log!.amount).toBe(-(after.currentPills - 30 + 30 - 29)); // -1
  });

  it('repeating alarm Take on same doseId does not deduct or mutate identity fields', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    const first = consumeDose(med, 'alarm', TODAY, now, 'd1');
    expect(first.doseAmount).toBe(1);
    expect(first.log).not.toBeNull();
    const afterFirst = first.updatedMed!;
    const snap = identitySnapshot(afterFirst);

    const second = consumeDose(afterFirst, 'alarm', TODAY, now, 'd1');
    expect(second.reason).toBe('already_consumed');
    expect(second.doseAmount).toBe(0);
    expect(second.updatedMed).toBeNull();
    expect(second.log).toBeNull();

    // Input med after first Take is unchanged by the failed second call.
    expect(identitySnapshot(afterFirst)).toEqual(snap);
    expect(effectiveCurrentPills(afterFirst, TODAY, now)).toBe(29);
  });

  it('Case 2: after alarm Take, syncAutoDailyDeductions does not re-deduct same dose/day', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    const preSync = syncAutoDailyDeductions([med], TODAY, now);
    expect(preSync.newLogs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    const medAfterPreSync = preSync.updatedMeds[0]!;
    expect(medAfterPreSync.currentPills).toBe(30);
    expect(effectiveCurrentPills(medAfterPreSync, TODAY, now)).toBe(29);

    const take = consumeDose(medAfterPreSync, 'alarm', TODAY, now, 'd1');
    expect(take.doseAmount).toBe(1);
    const afterTake = take.updatedMed!;
    expect(afterTake.currentPills).toBe(29);
    expect(afterTake.doseConsumption?.d1).toBe(TODAY);
    const snap = identitySnapshot(afterTake);

    const postSync = syncAutoDailyDeductions([afterTake], TODAY, now);
    expect(postSync.newLogs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    expect(postSync.updatedMeds[0]!.currentPills).toBe(29);
    expect(postSync.updatedMeds[0]!.doseConsumption?.d1).toBe(TODAY);
    expect(postSync.updatedMeds[0]!.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(postSync.updatedMeds[0]!, TODAY, now)).toBe(29);
    // lastSync may be normalized by sync when no deduction — still no double charge.
    expect(postSync.updatedMeds[0]!.doseConsumption).toEqual(snap.doseConsumption);
  });

  it('sibling isolation: taking d1 never mutates d2; later d2 Take is independent', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    const take = consumeDose(med, 'alarm', TODAY, now, 'd1');
    const after = take.updatedMed!;

    expect(after.doseConsumption?.d1).toBe(TODAY);
    expect(after.doseConsumption?.d2).toBeUndefined();
    expect(isDoseConsumedOnDate(after, 'd2', TODAY)).toBe(false);
    expect(after.currentPills).toBe(29);

    const evening = new Date('2024-09-12T21:00:00');
    expect(todayDueUnits(after, evening, TODAY)).toBe(2);
    expect(effectiveCurrentPills(after, TODAY, evening)).toBe(27);

    const takeD2 = consumeDose(after, 'alarm', TODAY, evening, 'd2');
    expect(takeD2.doseAmount).toBe(2);
    expect(takeD2.log?.doseId).toBe('d2');
    expect(takeD2.log?.amount).toBe(-2);
    expect(takeD2.updatedMed!.doseConsumption?.d1).toBe(TODAY);
    expect(takeD2.updatedMed!.doseConsumption?.d2).toBe(TODAY);
    // Final balance = 30 - 1 - 2
    expect(takeD2.updatedMed!.currentPills).toBe(27);
    expect(effectiveCurrentPills(takeD2.updatedMed!, TODAY, evening)).toBe(27);
  });

  it('identity is doseId not schedule index or display order', () => {
    const med = makeMed({
      doseSchedule: [
        { id: 'd2', amount: 2, time: '20:00' },
        { id: 'd1', amount: 1, time: '08:00' },
      ],
    });
    const now = NOW_AFTER_D1;

    const take = consumeDose(med, 'alarm', TODAY, now, 'd1');
    expect(take.doseAmount).toBe(1);
    expect(take.log?.doseId).toBe('d1');
    expect(take.updatedMed!.doseConsumption?.d1).toBe(TODAY);
    expect(take.updatedMed!.doseConsumption?.d2).toBeUndefined();
    expect(take.updatedMed!.currentPills).toBe(29);
  });
});

describe('B — Actual historical past settlement + same-day Take of today d1', () => {
  /**
   * Production allows actual auto snapshot change only for fully-elapsed
   * **past** days (betweenDays). After that settlement, Take for **today's**
   * d1 must still charge exactly once for today's identity and must not
   * re-apply past units (pastDueUnits becomes 0 after lastSync advances).
   */
  it('past auto_daily settles snapshot; then alarm Take of today d1 charges once only', () => {
    // lastSync = day before yesterday → one fully-elapsed day (yesterday)
    // between lastSync and today. daily schedule = 3 units for that day.
    const med = makeMed({
      currentPills: 30,
      lastSyncDate: '2024-09-10', // betweenDays to TODAY = 1 fully-elapsed day (11th)
    });
    const now = NOW_AFTER_D1;

    const breakdownBefore = computeDueDoseBreakdown(med, now, TODAY);
    expect(breakdownBefore.gated).toBe(true);
    expect(breakdownBefore.betweenDays).toBe(1);
    expect(breakdownBefore.pastDueUnits).toBe(3); // full yesterday schedule
    expect(breakdownBefore.todayDueUnits).toBe(1); // d1 only
    expect(breakdownBefore.fullDueUnits).toBe(4);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(26); // 30 - 4

    // Actual auto settlement of past only.
    const sync = syncAutoDailyDeductions([med], TODAY, now);
    const autoLogs = sync.newLogs.filter((l) => l.type === 'auto_daily');
    expect(autoLogs).toHaveLength(1);
    expect(autoLogs[0]!.amount).toBe(-3);
    expect(autoLogs[0]!.medicationId).toBe('med-1');
    expect(autoLogs[0]!.date).toBe(TODAY);

    const afterSync = sync.updatedMeds[0]!;
    expect(afterSync.currentPills).toBe(27); // 30 - 3 past only
    // Today d1 still not marked consumed — projection remains.
    expect(isDoseConsumedOnDate(afterSync, 'd1', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(afterSync, 'd2', TODAY)).toBe(false);
    expect(effectiveCurrentPills(afterSync, TODAY, now)).toBe(26); // 27 - 1 today d1
    expect(todayDueUnits(afterSync, now, TODAY)).toBe(1);

    // Past should no longer be due after settlement lastSync advance.
    const afterBreakdown = computeDueDoseBreakdown(afterSync, now, TODAY);
    expect(afterBreakdown.pastDueUnits).toBe(0);
    expect(afterBreakdown.todayDueUnits).toBe(1);

    // Take today's d1 via alarm path (same as Push / In-App handler).
    const take = consumeDose(afterSync, 'alarm', TODAY, now, 'd1');
    expect(take.reason).toBeUndefined();
    expect(take.doseAmount).toBe(1);
    expect(take.log?.type).toBe('dose_taken');
    expect(take.log?.doseId).toBe('d1');
    expect(take.log?.amount).toBe(-1);
    expect(take.log?.date).toBe(TODAY);

    const afterTake = take.updatedMed!;
    // Snapshot: 27 → 26 (today d1 only). Combined with auto: 30 - 3 - 1 = 26.
    expect(afterTake.currentPills).toBe(26);
    expect(afterTake.doseConsumption?.d1).toBe(TODAY);
    expect(afterTake.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(afterTake, TODAY, now)).toBe(26);

    // Accounting invariant: one auto_daily (-3) + one dose_taken (-1);
    // no second dose_taken; d2 never charged.
    expect(autoLogs).toHaveLength(1);
    expect(take.log).not.toBeNull();

    // Second Take same identity — no mutation.
    const snap = identitySnapshot(afterTake);
    const second = consumeDose(afterTake, 'alarm', TODAY, now, 'd1');
    expect(second.reason).toBe('already_consumed');
    expect(second.log).toBeNull();
    expect(second.updatedMed).toBeNull();
    expect(identitySnapshot(afterTake)).toEqual(snap);

    // Sync again after Take — no additional auto_daily for today d1.
    const postSync = syncAutoDailyDeductions([afterTake], TODAY, now);
    expect(postSync.newLogs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    expect(postSync.updatedMeds[0]!.currentPills).toBe(26);
    expect(postSync.updatedMeds[0]!.doseConsumption?.d1).toBe(TODAY);
    expect(postSync.updatedMeds[0]!.doseConsumption?.d2).toBeUndefined();
  });

  it('past-day slot already recorded as consumed is skipped by historical auto (no double with later Take of today)', () => {
    // Yesterday's d1 was manually taken; auto must not charge that slot amount
    // again when settling the past day — only d2 of yesterday remains due.
    const med = makeMed({
      currentPills: 30,
      lastSyncDate: '2024-09-10',
      doseConsumption: { d1: YESTERDAY },
      doseConsumptionHistory: { d1: [YESTERDAY] },
    });
    const now = NOW_AFTER_D1;

    const b = computeDueDoseBreakdown(med, now, TODAY);
    // Yesterday: d1 skipped (consumed), d2 amount 2 still due → pastDueUnits 2
    expect(b.pastDueUnits).toBe(2);
    expect(b.todayDueUnits).toBe(1); // today d1 not consumed

    const sync = syncAutoDailyDeductions([med], TODAY, now);
    expect(sync.newLogs.filter((l) => l.type === 'auto_daily')).toHaveLength(1);
    expect(sync.newLogs[0]!.amount).toBe(-2);
    expect(sync.updatedMeds[0]!.currentPills).toBe(28);

    const take = consumeDose(sync.updatedMeds[0]!, 'alarm', TODAY, now, 'd1');
    expect(take.doseAmount).toBe(1);
    expect(take.log?.doseId).toBe('d1');
    expect(take.log?.date).toBe(TODAY);
    // 28 - 1 today; yesterday d1 was already in history, not re-charged.
    expect(take.updatedMed!.currentPills).toBe(27);
    expect(take.updatedMed!.doseConsumption?.d1).toBe(TODAY);
    // History still knows about yesterday when present.
    expect(
      take.updatedMed!.doseConsumptionHistory?.d1?.includes(YESTERDAY) ||
        take.updatedMed!.doseConsumption?.d1 === TODAY
    ).toBe(true);
  });
});

describe('Push take_dose action uses same alarm consume path', () => {
  /**
   * Mirrors App.tsx:
   *   if (actionId !== 'take_dose') return;
   *   handleTakeDoseFromAlarm(medication, doseId)
   *     → consumeDose(med, 'alarm', today, now, doseId)
   */
  function applyTakeDoseAction(
    med: Medication,
    actionId: string,
    medicationId: string,
    doseId: string | undefined,
    today: string,
    now: Date
  ): {
    med: Medication;
    logs: ConsumptionLog[];
    lastResult: ReturnType<typeof consumeDose>;
  } {
    const logs: ConsumptionLog[] = [];
    let current = med;
    let lastResult: ReturnType<typeof consumeDose> = {
      updatedMed: null,
      doseAmount: 0,
      log: null,
    };
    if (actionId !== 'take_dose') return { med: current, logs, lastResult };
    if (medicationId !== current.id) return { med: current, logs, lastResult };
    lastResult = consumeDose(current, 'alarm', today, now, doseId);
    if (lastResult.updatedMed && lastResult.log) {
      current = lastResult.updatedMed;
      logs.push(lastResult.log);
    }
    return { med: current, logs, lastResult };
  }

  it('Push take_dose for elapsed d1: one dose_taken, one deduction, d2 untouched', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;
    expect(med.currentPills).toBe(30);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(29);

    const once = applyTakeDoseAction(med, 'take_dose', 'med-1', 'd1', TODAY, now);
    expect(once.logs).toHaveLength(1);
    expect(once.logs[0]!.type).toBe('dose_taken');
    expect(once.logs[0]!.doseId).toBe('d1');
    expect(once.logs[0]!.amount).toBe(-1);
    expect(once.med.currentPills).toBe(29);
    expect(once.med.doseConsumption?.d1).toBe(TODAY);
    expect(once.med.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(once.med, TODAY, now)).toBe(29);

    const snap = identitySnapshot(once.med);
    const twice = applyTakeDoseAction(once.med, 'take_dose', 'med-1', 'd1', TODAY, now);
    expect(twice.lastResult.reason).toBe('already_consumed');
    expect(twice.logs).toHaveLength(0);
    expect(identitySnapshot(twice.med)).toEqual(snap);
  });

  it('wrong actionId is a no-op', () => {
    const med = makeMed();
    const result = applyTakeDoseAction(
      med,
      'dismiss',
      'med-1',
      'd1',
      TODAY,
      NOW_AFTER_D1
    );
    expect(result.logs).toHaveLength(0);
    expect(result.med.currentPills).toBe(30);
    expect(result.med.doseConsumption).toBeUndefined();
  });
});
