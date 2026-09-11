import { useEffect, useRef } from 'react';
import { Medication, calculateMedicationStatus, CriticalTransitionState } from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import { sendCriticalStockAlert } from '../utils/notifications';
import {
  loadCriticalTransitions,
  saveCriticalTransitions,
  loadScheduledCriticalAlarms,
  saveScheduledCriticalAlarms,
  generateCriticalTransitionKey,
} from '../utils/criticalTransitions';

interface UseStockAlertsOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
}

/**
 * Watch the medications array + notification flags and manage critical-stock
 * alert transitions.
 *
 * == Core Invariant ==
 * For one continuous critical-stock episode of one medication, the app must
 * never show more than ONE user-facing critical-stock notification.
 *
 * == Episode Lifecycle ==
 * - Transitions are tracked in `android_med_tracker_critical_transition_v1`
 *   as `{ transitionKey, enteredAt, notificationSent }`.
 * - A new transition is created ONLY on Sufficient → Critical (or initial entry).
 * - Critical → OutOfStock is the same transition (no new notification).
 * - Decreasing pills / doses taken while remaining critical are the same transition.
 * - Critical → Sufficient ends the transition (record is removed).
 *
 * == Scheduled Alarm Claiming & Reconciliation ==
 * When a scheduled alarm claimed the upcoming critical transition and its
 * alarm date has passed (`alarmTime <= now`), the system recognizes that the
 * alarm was delivered while the app was in the background/closed.
 * It adopts the claimed transition, marks `notificationSent: true`, and updates
 * the scheduled alarm record to `DELIVERED`, suppressing foreground duplication.
 *
 * == Disabled / Re-enabled Notifications ==
 * If critical alerts or notifications are disabled when the medication becomes
 * critical, `notificationSent` remains `false`. When alerts are enabled later,
 * exactly ONE notification will fire for the active transition.
 */
export function useStockAlerts({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  const transitionsRef = useRef<Record<string, CriticalTransitionState> | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (isFirstRun) return;

    if (transitionsRef.current === null) {
      transitionsRef.current = loadCriticalTransitions();
    }
    const transitions = transitionsRef.current;
    const scheduled = loadScheduledCriticalAlarms();
    let transitionsDirty = false;
    let scheduledDirty = false;
    const now = Date.now();

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const effPills = effectiveCurrentPills(med);
      const isCritical = status === 'critical' || status === 'out_of_stock';

      if (!isCritical) {
        // "Critical → Sufficient ends the transition"
        if (transitions[med.id]) {
          delete transitions[med.id];
          transitionsDirty = true;
        }
        continue;
      }

      // The medication is critical or out of stock.
      let currentTransition = transitions[med.id];
      const scheduledRec = scheduled[med.id];

      // Check if a scheduled alarm claimed this transition and has already delivered
      const isAlarmDelivered = Boolean(
        scheduledRec &&
        (scheduledRec.status === 'SCHEDULED' || scheduledRec.status === 'DELIVERED') &&
        scheduledRec.alarmTime <= now
      );

      if (!currentTransition) {
        if (isAlarmDelivered && scheduledRec) {
          // Scheduled alarm delivered while the app was closed.
          currentTransition = {
            transitionKey: scheduledRec.transitionKey,
            enteredAt: scheduledRec.alarmTime,
            notificationSent: true,
          };
          transitions[med.id] = currentTransition;
          transitionsDirty = true;
          if (scheduledRec.status !== 'DELIVERED') {
            scheduledRec.status = 'DELIVERED';
            scheduledDirty = true;
          }
        } else {
          // New critical transition starting in foreground (or alarm not fired/scheduled).
          const transitionKey = scheduledRec?.transitionKey || generateCriticalTransitionKey(med.id, now);
          currentTransition = {
            transitionKey,
            enteredAt: now,
            notificationSent: false,
          };
          transitions[med.id] = currentTransition;
          transitionsDirty = true;
        }
      } else if (isAlarmDelivered && scheduledRec && !currentTransition.notificationSent) {
        currentTransition.notificationSent = true;
        transitionsDirty = true;
        if (scheduledRec.status !== 'DELIVERED') {
          scheduledRec.status = 'DELIVERED';
          scheduledDirty = true;
        }
      }

      // Foreground notification dispatch
      if (!currentTransition.notificationSent) {
        if (notificationsEnabled && criticalStockAlertsEnabled) {
          sendCriticalStockAlert(med.id, med.name, daysLeft, effPills, med.unit || 'قرص');
          currentTransition.notificationSent = true;
          transitionsDirty = true;
        }
      }
    }

    // Clean up entries for deleted medications
    const medIds = new Set(medications.map((m) => m.id));
    for (const id of Object.keys(transitions)) {
      if (!medIds.has(id)) {
        delete transitions[id];
        transitionsDirty = true;
      }
    }

    if (transitionsDirty) {
      saveCriticalTransitions(transitions);
    }
    if (scheduledDirty) {
      saveScheduledCriticalAlarms(scheduled);
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}

