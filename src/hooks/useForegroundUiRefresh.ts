import { useEffect, useReducer } from 'react';
import { isAppInForeground } from '../utils/notifications';

/**
 * Keeps time-sensitive UI state fresh while the app is visible.
 * This is UI-only: native exact alarms remain the authoritative timing source
 * for Exact Auto, while this refresh lets elapsed/future dose labels cross
 * their scheduled time without waiting for another user action or app event.
 *
 * The timer is stopped when the native app-state tracker reports background.
 * resumeTick forces the effect to restart when the app returns to foreground.
 */
export function useForegroundUiRefresh(
  resumeTick: number,
  intervalMs = 10_000
): void {
  const [, forceRefresh] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (cancelled || !isAppInForeground()) return;
      timer = setTimeout(() => {
        if (cancelled || !isAppInForeground()) return;
        forceRefresh();
        schedule();
      }, intervalMs);
    };

    schedule();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [resumeTick, intervalMs]);
}
