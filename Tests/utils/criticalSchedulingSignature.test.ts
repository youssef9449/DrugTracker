import { describe, expect, it } from 'vitest';
import type { Medication } from '@/types';
import {
  computeMedicationCriticalSchedulingSignature,
  createCriticalSchedulingSignatureMemoizer,
  isCriticalSchedulingStateUnchanged,
} from '@/utils/criticalSchedulingSignature';

/**
 * #494 regression/performance coverage: Critical Stock scheduling
 * signatures are memoized PER MEDICATION. One medication changing must not
 * force unchanged medications to rebuild their serialized
 * signature/history representation, while every field that can affect
 * getCriticalAlarmDate() still invalidates correctly.
 */

const CUTOFF = '2026-03-10';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Med',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    criticalStockAlertsEnabled: true,
    doseSchedule: [
      { id: 'dose-1', amount: 1, time: '09:00' },
      { id: 'dose-2', amount: 1, time: '21:00' },
    ],
    doseConsumptionHistory: {},
    doseSkippedHistory: {},
    ...overrides,
  };
}

function largeHistory(from: number, to: number): Record<string, string[]> {
  const dates: string[] = [];
  for (let i = from; i <= to; i += 1) {
    dates.push(`2026-01-${String(i).padStart(2, '0')}`);
  }
  return { 'dose-1': dates, 'dose-2': dates };
}

describe('#494 per-medication signature memoization', () => {
  it('one med changes while many others remain unchanged: only that med recomputes', () => {
    const memoizer = createCriticalSchedulingSignatureMemoizer();
    const meds = Array.from({ length: 50 }, (_, i) =>
      makeMed({ id: `med-${i}` })
    );
    const first = memoizer.signature(meds, CUTOFF);
    expect(memoizer.stats()).toEqual({ reused: 0, recomputed: 50 });

    const changed = [
      makeMed({ id: 'med-0', currentPills: 12 }),
      ...meds.slice(1),
    ];
    const second = memoizer.signature(changed, CUTOFF);

    // 49 unchanged meds reused; exactly 1 recomputed.
    expect(memoizer.stats()).toEqual({ reused: 49, recomputed: 51 });
    expect(second).not.toBe(first);
    // The changed fragment is reflected in the combined signature.
    expect(second).toContain('med-0|12|');
  });

  it('recreating medication objects with identical scheduling state reuses the cache (no identity-only reliance)', () => {
    const memoizer = createCriticalSchedulingSignatureMemoizer();
    const meds = [makeMed(), makeMed({ id: 'med-2' })];
    memoizer.signature(meds, CUTOFF);
    // Fresh objects, same content — callers recreate medication objects.
    const recreated = [makeMed(), makeMed({ id: 'med-2' })];
    memoizer.signature(recreated, CUTOFF);
    expect(memoizer.stats().reused).toBe(2);
  });

  it('large OLD histories do not trigger unnecessary full-history work for unchanged meds', () => {
    const memoizer = createCriticalSchedulingSignatureMemoizer();
    const meds = Array.from({ length: 30 }, (_, i) =>
      makeMed({
        id: `med-${i}`,
        doseConsumptionHistory: largeHistory(1, 28),
        doseSkippedHistory: largeHistory(1, 28),
      })
    );
    memoizer.signature(meds, CUTOFF);
    memoizer.signature(meds.map((m) => ({ ...m })), CUTOFF);
    // Every med reused its cached fragment — the big old histories were
    // not re-serialized on the second pass.
    expect(memoizer.stats()).toEqual({ reused: 30, recomputed: 30 });
  });

  it('appending an OLD history date never changes the signature (outside the scheduling window)', () => {
    const before = computeMedicationCriticalSchedulingSignature(
      makeMed({ doseConsumptionHistory: largeHistory(1, 28) }),
      CUTOFF
    );
    const withOldMarker = makeMed({
      doseConsumptionHistory: largeHistory(1, 29), // 2026-01-29 < CUTOFF
    });
    const after = computeMedicationCriticalSchedulingSignature(
      withOldMarker,
      CUTOFF
    );
    expect(after).toBe(before);
  });

  it('a FUTURE history marker still invalidates scheduling (recompute + signature change)', () => {
    const memoizer = createCriticalSchedulingSignatureMemoizer();
    const base = makeMed({
      doseConsumptionHistory: { 'dose-1': ['2026-03-12'] },
    });
    const first = memoizer.signature([base], CUTOFF);
    const changed = makeMed({
      doseConsumptionHistory: { 'dose-1': ['2026-03-12', '2026-03-14'] },
    });
    const second = memoizer.signature([changed], CUTOFF);
    expect(memoizer.stats()).toEqual({ reused: 0, recomputed: 2 });
    expect(second).not.toBe(first);
  });

  it('every scheduling-relevant field change invalidates: stock, rate, threshold, auto, per-med flag, schedule, metadata', () => {
    const cases: Array<Partial<Medication>> = [
      { currentPills: 29 }, // stock
      { dailyDose: 3 }, // daily amount/rate fallback
      { warningThresholdDays: 2 }, // threshold
      { autoDeductEnabled: false }, // Auto state
      { criticalStockAlertsEnabled: false }, // per-med Critical setting
      { doseSchedule: [{ id: 'dose-1', amount: 2, time: '09:00' }] }, // schedule rows
      { name: 'Renamed' }, // notification metadata
      { unit: 'حقنة' }, // notification metadata
    ];

    for (const override of cases) {
      const memoizer = createCriticalSchedulingSignatureMemoizer();
      const base = makeMed();
      const first = memoizer.signature([base], CUTOFF);
      const changed = makeMed(override);
      const second = memoizer.signature([changed], CUTOFF);
      expect(second, `signature must change for ${JSON.stringify(override)}`).not.toBe(
        first
      );
      expect(memoizer.stats().recomputed).toBe(2);
      expect(isCriticalSchedulingStateUnchanged(base, changed)).toBe(false);
    }
  });

  it('consume vs skip history are tracked independently', () => {
    const consumeSig = computeMedicationCriticalSchedulingSignature(
      makeMed({ doseConsumptionHistory: { 'dose-1': ['2026-03-11'] } }),
      CUTOFF
    );
    const skipSig = computeMedicationCriticalSchedulingSignature(
      makeMed({ doseSkippedHistory: { 'dose-1': ['2026-03-11'] } }),
      CUTOFF
    );
    expect(consumeSig).not.toBe(skipSig);
  });

  it('removing a medication evicts its fragment; reordering does not change the combined signature', () => {
    const memoizer = createCriticalSchedulingSignatureMemoizer();
    const a = makeMed({ id: 'a' });
    const b = makeMed({ id: 'b' });
    const c = makeMed({ id: 'c' });
    const s1 = memoizer.signature([a, b, c], CUTOFF);
    const s2 = memoizer.signature([c, a, b], CUTOFF);
    expect(s2).toBe(s1);
    memoizer.signature([a, c], CUTOFF);
    // b was evicted; re-adding recomputes it.
    const statsBefore = memoizer.stats();
    memoizer.signature([a, b, c], CUTOFF);
    expect(memoizer.stats().recomputed).toBe(statsBefore.recomputed + 1);
  });
});
