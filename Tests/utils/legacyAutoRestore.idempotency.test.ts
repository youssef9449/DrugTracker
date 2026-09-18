/**
 * Phase 4 regression — Legacy Auto-only Restore idempotency (Note 1).
 *
 * Occurrence identity for a legacy (no doseSchedule) medication's implicit
 * daily dose is medicationId + LEGACY_DOSE_ID + calendarDate.
 *
 * Bug: the legacy auto-only Restore did not register the restore for the
 * legacy occurrence (no durable skip marker), so a second Restore for the
 * same day/occurrence credited the same amount again (stock inflation).
 *
 * Contract (same idempotency semantics as exact/multi-dose):
 *   1. First auto-only Restore → stock increases by exactly the actual auto
 *      deduction amount AND a durable skip marker (LEGACY_DOSE_ID + today)
 *      is recorded inside the SAME atomic mutation.
 *   2. Second Restore for the same occurrence → zero-mutation no-op
 *      (already_restored): balance byte-for-byte unchanged, no additional
 *      restore log. Exact assertions — never bounds.
 *   3. Manual Take after the Restore treats it as the SAME occurrence:
 *      clears the skip marker within the Take mutation; the occurrence
 *      becomes restorable again (existing lifecycle contract).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import {
  runGatedManualConsume,
  runGatedManualRestore,
} from '../../src/utils/manualStockMutation';
import {
  __setAutoStockGateTestHooks,
  type AutoStockDurableState,
} from '../../src/utils/autoDeductionStockGate';
import {
  isDoseSkippedOnDate,
  isDoseConsumedOnDate,
} from '../../src/utils/dateCalculations';
import { LEGACY_DOSE_ID } from '../../src/utils/legacyDoseId';
import {
  getAutoRestorableDose,
  hasAutoRestorableDoseToday,
} from '../../src/utils/doseSchedule';

const TODAY = '2026-09-16';
const NOW = new Date(`${TODAY}T15:00:00`);

function legacyMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'LegacyMed',
    currentPills: 50,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    // Today's auto deduction was already settled into the stock snapshot
    // (lastSyncDate = today, no consume marker) → auto-only restorable.
    lastSyncDate: TODAY,
    reminderTime: '08:00',
    autoDeductEnabled: true,
    doseSchedule: undefined,
    dosesPerDay: undefined,
    ...over,
  };
}

describe('Phase 4 — legacy auto-only Restore idempotency (LEGACY_DOSE_ID + today)', () => {
  let durable: AutoStockDurableState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    durable = { medications: [legacyMed()], logs: [] };
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: durable.medications.map((m) => ({ ...m })),
        logs: durable.logs.map((l) => ({ ...l })),
      }),
      commit: (state) => {
        durable = {
          medications: state.medications.map((m) => ({ ...m })),
          logs: state.logs.map((l) => ({ ...l })),
        };
        return null;
      },
    });
  });

  afterEach(() => {
    __setAutoStockGateTestHooks(null);
    vi.useRealTimers();
  });

  it('first auto-only Restore credits the exact amount and records the skip marker atomically', async () => {
    const r1 = await runGatedManualRestore({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'legacy-restore-1',
    });
    expect(r1.outcome).toBe('applied');
    // Stock increased by exactly the actual auto deduction amount (dailyDose=1).
    expect(r1.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(51);
    // The legacy occurrence is durably marked restored (skip marker).
    expect(isDoseSkippedOnDate(durable.medications[0], LEGACY_DOSE_ID, TODAY)).toBe(true);
    // Exactly one restore log, part of the same committed mutation.
    expect(durable.logs.filter((l) => l.id === 'legacy-restore-1')).toHaveLength(1);
    expect(durable.logs.filter((l) => l.type === 'skipped_day')).toHaveLength(1);
  });

  it('second Restore for the same occurrence is an exact zero-mutation no-op', async () => {
    const r1 = await runGatedManualRestore({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'legacy-restore-1',
    });
    expect(r1.outcome).toBe('applied');
    const logsAfterFirst: ConsumptionLog[] = durable.logs.map((l) => ({ ...l }));
    const pillsAfterFirst = durable.medications[0].currentPills;
    expect(pillsAfterFirst).toBe(51);

    const r2 = await runGatedManualRestore({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'legacy-restore-2',
    });
    expect(r2.outcome).toBe('already_restored');
    expect(r2.restoredAmount).toBe(0);
    expect(r2.log).toBeNull();
    // Exact zero mutation: balance byte-for-byte identical, no new log.
    expect(durable.medications[0].currentPills).toBe(51);
    expect(durable.medications[0].currentPills).toBe(pillsAfterFirst);
    expect(durable.logs).toHaveLength(logsAfterFirst.length);
    expect(durable.logs.filter((l) => l.id === 'legacy-restore-2')).toHaveLength(0);
    expect(durable.logs.filter((l) => l.type === 'skipped_day')).toHaveLength(1);
    expect(isDoseSkippedOnDate(durable.medications[0], LEGACY_DOSE_ID, TODAY)).toBe(true);
    // lastConsumedDate (stock-owned projection field) untouched by the no-op.
    expect(durable.medications[0].lastConsumedDate).toBeUndefined();
  });

  it('auto-restore eligibility is off while the skip marker is set (UI parity with slots)', async () => {
    await runGatedManualRestore({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'legacy-restore-1',
    });
    expect(getAutoRestorableDose(durable.medications[0], NOW, TODAY)).toBeNull();
    expect(hasAutoRestorableDoseToday(durable.medications[0], NOW, TODAY)).toBe(false);
  });

  it('Manual Take after the Restore clears the skip marker and re-opens the occurrence', async () => {
    await runGatedManualRestore({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'legacy-restore-1',
    });
    expect(durable.medications[0].currentPills).toBe(51);
    expect(isDoseSkippedOnDate(durable.medications[0], LEGACY_DOSE_ID, TODAY)).toBe(true);

    const take = await runGatedManualConsume({
      medicationId: 'med-1',
      source: 'manual',
      todayStr: TODAY,
    });
    expect(take.outcome).toBe('applied');
    expect(take.doseAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(50);
    // Same occurrence: the Take cleared the restore skip marker.
    expect(isDoseSkippedOnDate(durable.medications[0], LEGACY_DOSE_ID, TODAY)).toBe(false);
    expect(isDoseConsumedOnDate(durable.medications[0], LEGACY_DOSE_ID, TODAY)).toBe(true);

    // The occurrence is restorable again per the existing lifecycle contract:
    // this Restore reverses the Take (not the earlier auto deduction).
    const r2 = await runGatedManualRestore({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'legacy-restore-2',
    });
    expect(r2.outcome).toBe('applied');
    expect(r2.restoredAmount).toBe(1);
    expect(durable.medications[0].currentPills).toBe(51);
    // And a further auto-only Restore after that is again a no-op.
    const r3 = await runGatedManualRestore({
      medicationId: 'med-1',
      todayStr: TODAY,
      makeLogId: () => 'legacy-restore-3',
    });
    expect(r3.outcome).toBe('already_restored');
    expect(durable.medications[0].currentPills).toBe(51);
    expect(durable.logs.filter((l) => l.id === 'legacy-restore-3')).toHaveLength(0);
  });
});
