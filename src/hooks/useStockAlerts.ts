import { useEffect, useRef } from 'react';
import {
  Medication,
  MedicationStatus,
  calculateMedicationStatus,
} from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import {
  sendMedicineAlert,
  sendCriticalStockAlert,
} from '../utils/notifications';

/**
 * Severity rank for MedicationStatus, used to decide whether a status
 * change is a worsening (fire) or an improvement (don't fire, just
 * update the tracker). Higher = worse.
 */
const STATUS_RANK: Record<MedicationStatus, number> = {
  sufficient: 0,
  warning: 1,
  critical: 2,
  out_of_stock: 3,
};

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
 * the FIRST time a medication WORSENS (audit #87).
 *
 * Extracted from App.tsx (was a ~70-line inline useEffect). Tracks the
 * last-alerted status per med in a ref and compares severity ranks
 * (out_of_stock > critical > warning > sufficient). Only fires when the
 * new status is STRICTLY WORSE than the previously-alerted one — so a
 * partial refill that improves a med from critical→warning does NOT fire
 * a spurious "warning" alert. When a med improves to 'sufficient', the
 * tracker is cleared so the next crossing alerts again. When notifications
 * are toggled off, the tracker is cleared so re-enabling fires for current
 * alertable meds again.
 */
export function useStockAlerts({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  const lastAlertedStatusRef = useRef<Map<string, MedicationStatus>>(new Map());

  useEffect(() => {
    if (!hydrated) return;
    // First-run: don't fire ghost notifications for seed data.
    if (isFirstRun) return;

    // When notifications are off, reset the tracker so the next time
    // they're turned on, current alertable meds fire again.
    if (!notificationsEnabled) {
      lastAlertedStatusRef.current.clear();
      return;
    }

    const tracker = lastAlertedStatusRef.current;
    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      // The dynamic balance — what the user actually has right now, not
      // the stale stored snapshot. Used in the notification body text so
      // it stays correct even if the app was closed for many days.
      const effPills = effectiveCurrentPills(med);
      const prev = tracker.get(med.id);

      // Med is healthy → clear its tracker so the next worsening alerts.
      if (status === 'sufficient') {
        tracker.delete(med.id);
        continue;
      }

      // Already alerted for this exact (or a worse) status → don't
      // re-fire. `prev` records the worst status we've already alerted
      // for; if the new status is the same or better, skip.
      if (prev !== undefined && STATUS_RANK[status] <= STATUS_RANK[prev]) {
        // Update the tracker if the status improved (so a later
        // worsening from the new, better baseline fires again).
        if (STATUS_RANK[status] < STATUS_RANK[prev]) {
          tracker.set(med.id, status);
        }
        continue;
      }

      // New med (prev undefined) OR status strictly worsened → fire the
      // appropriate alert(s) for the new status.
      if (status === 'out_of_stock') {
        if (criticalStockAlertsEnabled) {
          sendCriticalStockAlert(med.id, med.name, 0, 0, med.unit || 'قرص');
        }
        // Also send the general low-stock alert so it appears as its
        // own drawer entry (different notification id).
        sendMedicineAlert(med.id, med.name, 0, 0);
      } else if (status === 'critical') {
        if (criticalStockAlertsEnabled) {
          sendCriticalStockAlert(med.id, med.name, daysLeft, effPills, med.unit || 'قرص');
        }
        // Critical is a subset of the warning window — also send the
        // general alert (separate drawer entry, less urgent wording).
        sendMedicineAlert(med.id, med.name, daysLeft, effPills);
      } else if (status === 'warning') {
        sendMedicineAlert(med.id, med.name, daysLeft, effPills);
      }

      tracker.set(med.id, status);
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
