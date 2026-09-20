import { useEffect, useState } from 'react';

/**
 * Returns a counter that increments once per local calendar-day rollover
 * (midnight in the device's local timezone) while the app stays open.
 *
 * Effects that depend on the current calendar date (Exact Auto scheduling,
 * reconciliation, and related date-bound work) compute "today" from the wall
 * clock at effect-run time, but only re-run on hydration/resume/config change.
 * While the app stays open across midnight, this tick fires at the day boundary
 * so those consumers re-run for the new calendar date without waiting for the
 * next resume.
 *
 * Implementation notes:
 * - One self-correcting timer, re-armed from the current wall clock after
 *   every fire (not an interval) — clock changes and device sleep shift the
 *   next fire to the real local midnight.
 * - The delay is clamped to ≥1s so a clock adjustment cannot schedule a 0/neg-
 *   ative timeout.
 * - The tick is a pure signal: consumers decide what to re-run (reconciliation
 *   and desired-state scheduling both re-read durable state, so a stale or
 *   duplicated tick is harmless).
 */
export function useMidnightTick(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const armNextMidnight = () => {
      if (cancelled) return;
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        0
      );
      const delay = Math.max(1_000, nextMidnight.getTime() - now.getTime());
      timer = setTimeout(() => {
        if (cancelled) return;
        setTick((t) => t + 1);
        armNextMidnight();
      }, delay);
    };

    armNextMidnight();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return tick;
}
