/**
 * Feature-neutral app-resume event fan-out.
 *
 * Capacitor's App resume callback is single-slot: the one registered handler
 * (useNativeActionHandlers) owns it. Independent consumers that need a
 * lifecycle reconciliation trigger — without polling/timers and without
 * re-registering the native listener — subscribe here. The publisher simply
 * forwards foreground/background transitions; subscribers keep their own
 * feature policy.
 */

export interface AppResumeEvent {
  /** True when the app came to the foreground; false on backgrounding. */
  isActive: boolean;
}

type AppResumeListener = (event: AppResumeEvent) => void;

const listeners = new Set<AppResumeListener>();

/** Subscribe for the lifetime of a mount. Returns the unsubscribe fn. */
export function subscribeToAppResumeEvents(
  listener: AppResumeListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publisher-side hook (called by the single native resume handler). */
export function publishAppResumeEvent(event: AppResumeEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[app-resume] subscriber failed:', error);
    }
  }
}
