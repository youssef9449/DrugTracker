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
 *   - The legacy day-based catch-up (syncAutoDailyDeductions) was removed in
 *     Issue #268 / PR #271. Today's slots stay a dynamic projection via
 *     effectiveCurrentPills / todayDueUnits until consumeDose (manual Take) or
 *     an Exact FIRED occurrence settles them.
 *   - Therefore "actual auto snapshot settlement of **today's** d1, then
 *     same-day Take of d1" is **impossible by design** — not a missing
 *     test, a production boundary. Same-day due is projection-only.
 *   - Take always targets **today's** identity, so it must not invent a
 *     second charge for today's slot (the durable per-dose consume marker
 *     prevents a second Take).
 *
 * Scenario (product request):
 *   med-1: d1@08:00 amount 1, d2@20:00 amount 2
 *   now = 09:00 → d1 elapsed/due (projection), d2 still future
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  effectiveCurrentPills,
  computeDueDoseBreakdown,
  isDoseConsumedOnDate,
  todayDueUnits,
} from '@/utils/dateCalculations';
import { consumeDose } from '@/utils/medActions';
import type { Medication, ConsumptionLog } from '@/types';

const TODAY = '2024-09-12';
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
  it('today d1 is projection-only (effectiveCurrentPills), NOT settled into currentPills (gated multi)', () => {
    // Documents why "actual auto-deduct of today's d1 then Take" cannot
    // double-deduct: for a gated multi med, today's dose is a dynamic
    // projection (effectiveCurrentPills / todayDueUnits) and is NOT
    // settled into the durable snapshot at the calendar-day boundary.
    // (The legacy day-based catch-up that used to settle today's dose on
    // app-open was removed in Issue #268 / PR #271; today's dose is
    // settled only by a manual Take or an Exact FIRED occurrence.)
    const med = makeMed({ currentPills: 30, lastSyncDate: TODAY });
    const now = NOW_AFTER_D1;

    const before = computeDueDoseBreakdown(med, now, TODAY);
    expect(before.gated).toBe(true);
    expect(before.todayDueUnits).toBe(1);
    expect(before.pastDueUnits).toBe(0);
    expect(before.fullDueUnits).toBe(1);
    expect(med.currentPills).toBe(30);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(29);
    expect(isDoseConsumedOnDate(med, 'd1', TODAY)).toBe(false);
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

    // Accounting: log amount matches the persisted stock delta (30 → 29).
    expect(take.log!.amount).toBe(-(30 - after.currentPills));
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
