import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMidnightTick } from '../../src/hooks/useMidnightTick';

/**
 * Local-midnight rollover while the app stays open: the tick must fire once
 * per calendar-day boundary, re-arm for the following boundary, and never
 * fire early. Fake timers freeze Date at the test's real start instant, so
 * the expected delay is computed with the same local-calendar arithmetic the
 * hook uses (deterministic in any host timezone).
 */
describe('useMidnightTick — local-midnight rollover while the app stays open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Mirrors the hook's own arithmetic (and respects its ≥1s clamp).
  const msToNextLocalMidnight = (from: Date): number =>
    Math.max(
      1_000,
      new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate() + 1,
        0,
        0,
        0,
        0
      ).getTime() - from.getTime()
    );

  it('starts at 0 and increments exactly once when local midnight passes', () => {
    const { result } = renderHook(() => useMidnightTick());
    expect(result.current).toBe(0);

    const frozen = new Date();
    act(() => {
      vi.advanceTimersByTime(msToNextLocalMidnight(frozen) + 1);
    });
    expect(result.current).toBe(1);
  });

  it('does not increment before midnight', () => {
    const { result } = renderHook(() => useMidnightTick());
    const frozen = new Date();
    const beforeBoundary = Math.max(
      0,
      msToNextLocalMidnight(frozen) - 60_000
    );
    act(() => {
      vi.advanceTimersByTime(beforeBoundary);
    });
    expect(result.current).toBe(0);
  });

  it('re-arms after firing so the next midnight also ticks', () => {
    const { result } = renderHook(() => useMidnightTick());
    const frozen = new Date();
    const firstDelay = msToNextLocalMidnight(frozen);
    act(() => {
      vi.advanceTimersByTime(firstDelay + 1);
    });
    expect(result.current).toBe(1);

    const afterFirst = new Date(frozen.getTime() + firstDelay + 1);
    act(() => {
      vi.advanceTimersByTime(msToNextLocalMidnight(afterFirst) + 1);
    });
    expect(result.current).toBe(2);
  });

  it('effect clean-up cancels the pending timer', () => {
    const { result, unmount } = renderHook(() => useMidnightTick());
    unmount();
    const frozen = new Date();
    act(() => {
      vi.advanceTimersByTime(msToNextLocalMidnight(frozen) + 1);
    });
    expect(result.current).toBe(0);
  });
});
