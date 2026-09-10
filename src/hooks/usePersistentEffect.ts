import { useEffect, useRef } from 'react';
import { persist } from '../utils/storage';

interface UsePersistentEffectOptions {
  /** Storage key. */
  storageKey: string;
  /** Value to persist. */
  value: unknown;
  /** Pass `{ json: false }` to write the value as a raw string (default true). */
  json?: boolean;
  /** Arabic toast message suffix shown on first quota failure (e.g. "قد لا يتم حفظ سجل الاستهلاك."). */
  failureMessage?: string;
  /** Toast callback — when omitted, failures are only console.warn'd (no toast). */
  showToast?: (message: string) => void;
  /** Debounce the write by N ms (defaults to 0 — write immediately). */
  debounceMs?: number;
  /** Gate: skip persistence until this is true (e.g. the `hydrated` flag). */
  enabled: boolean;
}

/**
 * Persist a value to localStorage on every change, surfacing quota failures
 * via a one-shot toast (audit #76).
 *
 * Collapses the 6 near-identical "warned-ref + persist + toast" effects that
 * lived inline in App.tsx into a single hook. The pattern:
 *   1. Skip until `enabled` (e.g. until hydration completes — otherwise the
 *      first mount would write the seed defaults, briefly overwriting the
 *      user's real data).
 *   2. Call `persist()`; on failure, set the warned-ref + toast the user
 *      once (the ref prevents spamming toasts on every re-render that
 *      re-attempts the same failing write).
 *   3. On success, clear the warned-ref so a future failure can toast again.
 *
 * The font-size effect is intentionally NOT collapsed here — it has a
 * CSS-class side effect + uses console.warn (not toast), so it stays inline.
 */
export function usePersistentEffect({
  storageKey,
  value,
  json = true,
  failureMessage,
  showToast,
  debounceMs = 0,
  enabled,
}: UsePersistentEffectOptions): void {
  const warnedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const doWrite = () => {
      const err = persist(storageKey, value, { json });
      if (err && !warnedRef.current) {
        warnedRef.current = true;
        if (failureMessage && showToast) {
          showToast(`${err} — ${failureMessage}`);
        } else {
          console.warn(`[usePersistentEffect] ${storageKey} write failed:`, err);
        }
      } else if (!err) {
        warnedRef.current = false;
      }
    };

    if (debounceMs > 0) {
      const handle = window.setTimeout(doWrite, debounceMs);
      return () => window.clearTimeout(handle);
    }
    doWrite();
  }, [storageKey, value, json, failureMessage, showToast, debounceMs, enabled]);
}
