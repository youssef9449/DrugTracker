import { useEffect, useRef } from 'react';
import {
  Medication,
  calculateMedicationStatus,
} from '../types';
import { effectiveCurrentPills, getCriticalTransitionKey } from '../utils/dateCalculations';
import { sendCriticalStockAlert } from '../utils/notifications';
import { loadJson, saveJson } from '../utils/storage';

const CRITICAL_NOTIFIED_KEY = 'android_med_tracker_critical_notified_v2';
const SCHEDULED_TRANSITIONS_KEY = 'android_med_tracker_scheduled_critical_v1';

interface UseStockAlertsOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
}

/**
 * Watch the medications array + notification flags and fire a notification
 * the FIRST time a medication transitions into a critical/out_of_stock state.
 *
 * == Transition-key dedup model ==
 * Instead of a per-med boolean, we persist a per-med transition key:
 *   `{ [medId]: "medId:2024-09-15:7" }`
 *
 * The key identifies the SPECIFIC critical transition (derived from the
 * threshold-crossing date). When the med leaves critical state, the key
 * is cleared. When it re-enters critical, a new key is computed and a
 * new notification is allowed.
 *
 * == Scheduled alarm reconciliation ==
 * When the app starts, we also load the persisted scheduled transitions
 * (written by useCriticalAlarmScheduler). For each med that is currently
 * critical:
 * - If the transition key matches a scheduled transition whose alarm
 *   date has already passed, the scheduled alarm already delivered the
 *   notification → mark as notified (prevents foreground duplicate).
 * - Otherwise, the transition hasn't been notified → foreground fires.
 *
 * == criticalStockAlertsEnabled fix ==
 * If critical alerts are disabled, the transition is NOT marked as
 * notified. When the user later enables critical alerts, the current
 * critical transition can still produce exactly ONE notification.
 */
export function useStockAlerts({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  const notifiedRef = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (isFirstRun) return;

    // Initialize from localStorage on first run after hydration.
    if (notifiedRef.current === null) {
      const persisted = loadJson<Record<string, string>>(CRITICAL_NOTIFIED_KEY, {});
      notifiedRef.current = new Map(Object.entries(persisted));

      // App-restart reconciliation: check if any scheduled critical
      // alarm has already fired while the app was closed.
      // If a med is currently critical and its transition key matches
      // a previously-scheduled transition, the alarm already delivered
      // the notification → mark as notified.
      const scheduled = loadJson<Record<string, string>>(SCHEDULED_TRANSITIONS_KEY, {});
      const today = new Date().toISOString().slice(0, 10);
      let reconcileDirty = false;

      for (const med of medications) {
        const transitionKey = getCriticalTransitionKey(med, today);
        if (!transitionKey) continue; // not critical

        // If this med had a scheduled alarm and the transition key
        // matches, the alarm likely already fired (the alarm date was
        // in the past). Mark as notified to prevent a foreground duplicate.
        if (scheduled[med.id] && scheduled[med.id] === transitionKey) {
          if (!notifiedRef.current.has(med.id)) {
            notifiedRef.current.set(med.id, transitionKey);
            reconcileDirty = true;
          }
        }
      }

      if (reconcileDirty) {
        saveJson(CRITICAL_NOTIFIED_KEY, Object.fromEntries(notifiedRef.current));
      }
    }

    const tracker = notifiedRef.current;

    if (!notificationsEnabled) {
      // Don't clear the tracker when notifications are globally off.
      // The transition identity persists; when notifications are re-enabled,
      // we check if the med is still in the same critical transition.
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    let dirty = false;

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const effPills = effectiveCurrentPills(med);
      const transitionKey = getCriticalTransitionKey(med, today);
      const notifiedKey = tracker.get(med.id);

      // Med is healthy → clear its notified entry so the next crossing
      // into critical triggers a new notification.
      if (status === 'sufficient' || !transitionKey) {
        if (notifiedKey) {
          tracker.delete(med.id);
          dirty = true;
        }
        continue;
      }

      // Med is critical/out_of_stock. Check if this specific transition
      // has already been notified.
      if (notifiedKey === transitionKey) {
        // Same transition already notified → skip.
        continue;
      }

      // New critical transition (or first time seeing this transition).
      // Only send a notification if critical alerts are enabled.
      if (criticalStockAlertsEnabled) {
        sendCriticalStockAlert(med.id, med.name, daysLeft, effPills, med.unit || 'قرص');
      }

      // Mark the transition as notified — BUT ONLY if a notification
      // was actually sent. If criticalStockAlertsEnabled is false,
      // the transition is NOT marked, so enabling alerts later can
      // still produce exactly ONE notification for this transition.
      if (criticalStockAlertsEnabled) {
        tracker.set(med.id, transitionKey);
        dirty = true;
      }
    }

    // Clean stale entries for deleted medications.
    const medIds = new Set(medications.map((m) => m.id));
    for (const key of tracker.keys()) {
      if (!medIds.has(key)) {
        tracker.delete(key);
        dirty = true;
      }
    }

    if (dirty) {
      saveJson(CRITICAL_NOTIFIED_KEY, Object.fromEntries(tracker));
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
