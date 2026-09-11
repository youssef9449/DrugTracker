import { useEffect, useRef } from 'react';
import {
  Medication,
  calculateMedicationStatus,
} from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import { sendCriticalStockAlert } from '../utils/notifications';
import { loadJson, saveJson } from '../utils/storage';

const CRITICAL_NOTIFIED_KEY = 'android_med_tracker_critical_notified_v1';

interface UseStockAlertsOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  /** Skip until hydration completes (avoids firing on seed defaults). */
  hydrated: boolean;
  /** First-run flag — don't fire ghost notifications for seed data. */
  isFirstRun: boolean;
}

/**
 * Watch the medications array + notification flags and fire a notification
 * the FIRST time a medication transitions into a critical/out_of_stock state.
 *
 * == Dedup model ==
 * A persistent map `CRITICAL_NOTIFIED_KEY` in localStorage tracks per-med
 * whether the current critical transition has already been notified:
 *   `{ [medId]: true }` — med is in critical state AND was already notified.
 *
 * When the med transitions back to 'sufficient', the entry is cleared.
 * When it transitions back to 'critical', a new notification is allowed.
 *
 * This ensures exactly ONE notification per state transition, regardless
 * of app restart, re-render, or scheduled alarm also firing.
 *
 * == No double notifications ==
 * Only `sendCriticalStockAlert` is called (one drawer entry per transition).
 * The old `sendMedicineAlert` (generic low-stock) is no longer fired
 * alongside the critical alert — it was producing a second drawer entry
 * for the same event.
 */
export function useStockAlerts({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  // In-memory cache synced from localStorage. Persists across re-renders
  // within the same hook instance. Loaded once on mount, then kept in
  // sync as we mutate it.
  const notifiedRef = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (isFirstRun) return;

    // Initialize from localStorage on first run after hydration.
    if (notifiedRef.current === null) {
      const persisted = loadJson<Record<string, boolean>>(CRITICAL_NOTIFIED_KEY, {});
      notifiedRef.current = new Map(Object.entries(persisted));
    }
    const tracker = notifiedRef.current;

    // When notifications are off, clear the tracker so the next time
    // they're turned on, current critical meds fire again.
    if (!notificationsEnabled) {
      if (tracker.size > 0) {
        tracker.clear();
        saveJson(CRITICAL_NOTIFIED_KEY, {});
      }
      return;
    }

    let dirty = false;

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const effPills = effectiveCurrentPills(med);
      const alreadyNotified = tracker.has(med.id);

      // Med is healthy → clear its notified flag so the next crossing
      // into critical triggers a new notification.
      if (status === 'sufficient') {
        if (alreadyNotified) {
          tracker.delete(med.id);
          dirty = true;
        }
        continue;
      }

      // Already notified for this critical transition → skip.
      if (alreadyNotified) continue;

      // New critical/out_of_stock transition → fire exactly ONE notification.
      if (status === 'critical' || status === 'out_of_stock') {
        if (criticalStockAlertsEnabled) {
          sendCriticalStockAlert(med.id, med.name, daysLeft, effPills, med.unit || 'قرص');
        }
        tracker.set(med.id, true);
        dirty = true;
      }
    }

    if (dirty) {
      saveJson(CRITICAL_NOTIFIED_KEY, Object.fromEntries(tracker));
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
