import { useEffect, useRef } from 'react';
import { Medication, calculateMedicationStatus, CriticalTransitionState } from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import {
  sendCriticalStockAlert,
  getDeliveredNotificationIds,
  criticalAlarmId,
} from '../utils/notifications';
import {
  loadCriticalTransitions,
  saveCriticalTransitions,
  loadScheduledCriticalAlarms,
  saveScheduledCriticalAlarms,
  reconcileCriticalEpisode,
  applyDeliveredCriticalEvidence,
} from '../utils/criticalTransitions';

interface UseStockAlertsOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
}

/**
 * Watch the medications array + notification flags and OWN the logical
 * critical-stock episode lifecycle.
 *
 * == Responsibilities (this hook is the single episode owner) ==
 * - Calculate current status (user-configured threshold ONLY:
 *   daysLeft <= warningThresholdDays → critical; effPills <= 0 →
 *   out_of_stock; no hidden derived sub-threshold).
 * - Create + persist a transition EXACTLY ONCE per continuous episode
 *   via the authoritative {@link reconcileCriticalEpisode} in
 *   criticalTransitions.ts (sufficient → critical/out_of_stock, or
 *   initial reconciliation of an already-critical med with no record).
 * - Preserve the transition (same key, same notification state)
 *   while the med stays critical/out_of_stock — across re-renders,
 *   days passing, auto deduction, manual consumption, refill-while-
 *   critical, lastSyncDate changes, app restarts, scheduler
 *   rescheduling, and the projected critical date moving.
 * - Delete the transition when the med becomes sufficient (episode end)
 *   and clear that episode's bound scheduled claim so a stale record
 *   can never suppress a future episode.
 * - Decide whether the foreground notification is still required:
 *   at most ONE user-facing notification per continuous transition.
 *
 * == Notification ownership ==
 *   Path A (foreground): transition.notificationState NONE → send → SENT.
 *   Path B (scheduled):  a validly-registered native alarm owns the
 *   episode's single notification → the episode is adopted with
 *   notificationState 'SCHEDULED' and the foreground stays quiet.
 *   SCHEDULED does NOT mean delivered: elapsed alarmTime is never
 *   treated as proof of delivery. Only positive native evidence
 *   (the alarm notification actually visible in the drawer, checked
 *   asynchronously below) upgrades an episode to 'SENT'.
 *
 * == Disabled / Re-enabled Notifications ==
 * If critical alerts or notifications are disabled when the medication
 * becomes critical, notificationState stays 'NONE' (never 'SENT').
 * When alerts are enabled later, exactly ONE notification fires for
 * the still-active episode.
 *
 * == Race safety ==
 * All state lives in synchronous localStorage and this effect is the
 * only transition creator. The scheduler (useCriticalAlarmScheduler)
 * only writes scheduled-alarm records — never identities — so React
 * effect execution order between the two hooks cannot produce
 * contradictory state. No artificial delays are used or needed.
 */
export function useStockAlerts({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  // In-memory mirror of the persistent transition map. Loaded once per
  // JS session, mutated by every reconcile pass, persisted when dirty.
  const transitionsRef = useRef<Record<string, CriticalTransitionState> | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (isFirstRun) return;

    if (transitionsRef.current === null) {
      transitionsRef.current = loadCriticalTransitions();
    }
    const transitions = transitionsRef.current;
    const scheduled = loadScheduledCriticalAlarms();
    const dirty = { transitions: false, scheduled: false };
    const now = Date.now();

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const effPills = effectiveCurrentPills(med);
      const isCriticalish = status === 'critical' || status === 'out_of_stock';

      reconcileCriticalEpisode(
        transitions,
        scheduled,
        {
          medId: med.id,
          isCriticalish,
          canNotify: notificationsEnabled && criticalStockAlertsEnabled,
          now,
          send: () => {
            void sendCriticalStockAlert(med.id, med.name, daysLeft, effPills, med.unit || 'قرص');
          },
        },
        dirty
      );
    }

    // Clean up transitions for deleted medications.
    const medIds = medications.map((m) => m.id);
    const medIdSet = new Set(medIds);
    for (const id of Object.keys(transitions)) {
      if (!medIdSet.has(id)) {
        delete transitions[id];
        dirty.transitions = true;
      }
    }
    // (Scheduled records of deleted meds are the SCHEDULER's
    // responsibility — it owns the native alarm cancellation.)

    if (dirty.transitions) {
      saveCriticalTransitions(transitions);
    }
    if (dirty.scheduled) {
      saveScheduledCriticalAlarms(scheduled);
    }

    // ── Delivery-evidence reconciliation (strict semantics) ──
    // For episodes in the 'SCHEDULED' state, check (native only, best
    // effort) whether the scheduled alarm notification is ACTUALLY
    // visible in the Android drawer. That is positive evidence of
    // delivery; absence proves nothing and changes nothing. This pass
    // NEVER treats elapsed alarmTime as delivery, and it only mutates
    // transitions (never the scheduler's records), so it cannot race
    // the scheduler's async record writes.
    const hasEvidenceCandidates = medIds.some(
      (id) => transitions[id]?.notificationState === 'SCHEDULED'
    );
    if (hasEvidenceCandidates) {
      void getDeliveredNotificationIds()
        .then((deliveredIds) => {
          const changed = applyDeliveredCriticalEvidence(
            medIds,
            deliveredIds,
            transitions,
            scheduled,
            criticalAlarmId
          );
          if (changed) {
            saveCriticalTransitions(transitions);
          }
        })
        .catch(() => undefined);
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
