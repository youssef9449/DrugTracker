/**
 * Regression: auto-due (time-elapsed projection) + Take from alarm / push
 * must deduct the same doseId only once.
 *
 * Production wiring (unchanged by this file):
 *   Push: localNotificationActionPerformed → registerNotificationActionHandler
 *         → actionId 'take_dose' → handleTakeDoseFromAlarm(med, doseId)
 *         → consumeDose(med, 'alarm', today, now, doseId)
 *   In-app: DoseAlarmModal onTakeDose → same handleTakeDoseFromAlarm
 *
 * Identity key: medicationId + doseId + date (not index / display time / dailyDose).
 *
 * Scenario (matches product request):
 *   med-1 with d1@08:00 amount 1, d2@20:00 amount 2
 *   now = 09:00 → d1 elapsed/due, d2 still future
 *   Auto-deduct enabled; today's slot stays projected until Take settles it.
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

afterEach(() => {
  vi.useRealTimers();
});

describe('Regression: auto-due + Take (alarm path) — no double deduction', () => {
  it('Case 1: d1 elapsed (projected due) then alarm Take deducts once only', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    // Pre-condition: d1 is auto-due via projection; d2 not yet due.
    const breakdown = computeDueDoseBreakdown(med, now, TODAY);
    expect(breakdown.gated).toBe(true);
    expect(breakdown.todayDueUnits).toBe(1);
    expect(todayDueUnits(med, now, TODAY)).toBe(1);
    expect(effectiveCurrentPills(med, TODAY, now)).toBe(29); // 30 - 1 (d1 projected)
    expect(isDoseConsumedOnDate(med, 'd1', TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(med, 'd2', TODAY)).toBe(false);

    // Production path for both Push take_dose and In-App DoseAlarmModal:
    // consumeDose(..., 'alarm', ..., doseId)
    const take = consumeDose(med, 'alarm', TODAY, now, 'd1');

    expect(take.reason).toBeUndefined();
    expect(take.doseAmount).toBe(1);
    expect(take.updatedMed).not.toBeNull();
    expect(take.log).not.toBeNull();
    expect(take.log!.type).toBe('dose_taken');
    expect(take.log!.doseId).toBe('d1');
    expect(take.log!.amount).toBe(-1);
    expect(take.log!.medicationId).toBe('med-1');
    expect(take.log!.date).toBe(TODAY);
    expect(take.log!.description).toContain('من التنبيه');

    const after = take.updatedMed!;
    // Snapshot settled: one deduction of d1 amount only.
    expect(after.currentPills).toBe(29);
    expect(after.doseConsumption?.d1).toBe(TODAY);
    expect(after.doseConsumption?.d2).toBeUndefined();
    expect(isDoseConsumedOnDate(after, 'd1', TODAY)).toBe(true);
    expect(isDoseConsumedOnDate(after, 'd2', TODAY)).toBe(false);

    // Effective balance still one deduction total (projection no longer includes d1).
    expect(effectiveCurrentPills(after, TODAY, now)).toBe(29);
    // Sibling d2 still future → not projected, not consumed.
    expect(todayDueUnits(after, now, TODAY)).toBe(0);
  });

  it('repeating alarm Take on same doseId does not deduct or log again', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    const first = consumeDose(med, 'alarm', TODAY, now, 'd1');
    expect(first.doseAmount).toBe(1);
    expect(first.log).not.toBeNull();
    const afterFirst = first.updatedMed!;
    const pillsAfterFirst = afterFirst.currentPills;
    expect(pillsAfterFirst).toBe(29);

    const second = consumeDose(afterFirst, 'alarm', TODAY, now, 'd1');
    expect(second.reason).toBe('already_consumed');
    expect(second.doseAmount).toBe(0);
    expect(second.updatedMed).toBeNull();
    expect(second.log).toBeNull();

    // State unchanged by second attempt.
    expect(afterFirst.currentPills).toBe(pillsAfterFirst);
    expect(afterFirst.doseConsumption?.d1).toBe(TODAY);
    expect(afterFirst.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(afterFirst, TODAY, now)).toBe(29);
  });

  it('Case 2: after alarm Take, syncAutoDailyDeductions does not re-deduct same dose/day', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    // Auto-sync before Take: gated path settles only past days.
    // Same-day lastSync → no past days → no auto_daily log; d1 stays projected.
    const preSync = syncAutoDailyDeductions([med], TODAY, now);
    expect(preSync.newLogs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    const medAfterPreSync = preSync.updatedMeds[0]!;
    expect(effectiveCurrentPills(medAfterPreSync, TODAY, now)).toBe(29);
    expect(medAfterPreSync.currentPills).toBe(30); // snapshot not yet settled for today

    const take = consumeDose(medAfterPreSync, 'alarm', TODAY, now, 'd1');
    expect(take.doseAmount).toBe(1);
    const afterTake = take.updatedMed!;
    expect(afterTake.currentPills).toBe(29);
    expect(afterTake.doseConsumption?.d1).toBe(TODAY);

    // Sync again after manual/alarm consumption — must not create extra
    // auto_daily for the same dose identity, and must not drop pills again.
    const postSync = syncAutoDailyDeductions([afterTake], TODAY, now);
    expect(postSync.newLogs.filter((l) => l.type === 'auto_daily')).toHaveLength(0);
    expect(postSync.updatedMeds[0]!.currentPills).toBe(29);
    expect(postSync.updatedMeds[0]!.doseConsumption?.d1).toBe(TODAY);
    expect(postSync.updatedMeds[0]!.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(postSync.updatedMeds[0]!, TODAY, now)).toBe(29);
  });

  it('sibling isolation: taking d1 never mutates d2 consumption or amount', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;

    const take = consumeDose(med, 'alarm', TODAY, now, 'd1');
    const after = take.updatedMed!;

    expect(after.doseConsumption?.d1).toBe(TODAY);
    expect(after.doseConsumption?.d2).toBeUndefined();
    expect(isDoseConsumedOnDate(after, 'd2', TODAY)).toBe(false);

    // At 21:00 d2 becomes due independently; d1 remains recorded once.
    const evening = new Date('2024-09-12T21:00:00');
    expect(todayDueUnits(after, evening, TODAY)).toBe(2); // only d2
    expect(effectiveCurrentPills(after, TODAY, evening)).toBe(27); // 29 - 2
    expect(isDoseConsumedOnDate(after, 'd1', TODAY)).toBe(true);

    const takeD2 = consumeDose(after, 'alarm', TODAY, evening, 'd2');
    expect(takeD2.doseAmount).toBe(2);
    expect(takeD2.log?.doseId).toBe('d2');
    expect(takeD2.updatedMed!.doseConsumption?.d1).toBe(TODAY);
    expect(takeD2.updatedMed!.doseConsumption?.d2).toBe(TODAY);
    expect(takeD2.updatedMed!.currentPills).toBe(27);
    expect(effectiveCurrentPills(takeD2.updatedMed!, TODAY, evening)).toBe(27);
  });

  it('identity is doseId not schedule index or display order', () => {
    // Reordered schedule: d2 listed first — Take still targets d1 by id.
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

describe('Regression: Push take_dose action uses same alarm consume path', () => {
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

  it('Push take_dose for elapsed d1: one dose_taken log, one deduction, d2 untouched', () => {
    const med = makeMed();
    const now = NOW_AFTER_D1;
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

    // Same push action again → no second log / no second deduction.
    const twice = applyTakeDoseAction(once.med, 'take_dose', 'med-1', 'd1', TODAY, now);
    expect(twice.lastResult.reason).toBe('already_consumed');
    expect(twice.logs).toHaveLength(0);
    expect(twice.med.currentPills).toBe(29);
    expect(twice.med.doseConsumption?.d2).toBeUndefined();
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
