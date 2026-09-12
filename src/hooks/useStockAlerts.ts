import { useEffect, useRef } from 'react';
import { Medication, calculateMedicationStatus, CriticalTransitionState } from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import {
  sendCriticalStockAlert,
  getDeliveredNotificationIds,
  criticalAlarmId,
  cancelCriticalAlarm,
} from '../utils/notifications';
import {
  loadCriticalTransitions,
  saveCriticalTransitions,
  loadScheduledCriticalAlarms,
  saveScheduledCriticalAlarms,
  loadOwnershipRevisions,
  saveOwnershipRevisions,
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
 *   ANY armed SCHEDULED claim for the medication is neutralized at that
 *   moment (see reconcileCriticalEpisode) AND the native alarm behind it
 *   is cancelled here (fire-and-forget, see below).
 *   Path B (scheduled):  a validly-registered native alarm owns the
 *   episode's single notification → the episode is adopted/bound with
 *   notificationState 'SCHEDULED' and the foreground stays quiet.
 *   SCHEDULED does NOT mean delivered: once the claim's firing window
 *   passes (alarmTime <= now) the episode becomes 'FIRED_OR_DUE' —
 *   delivery UNKNOWN, claim consumed, never re-armed, foreground stays
 *   quiet. Elapsed alarmTime is never treated as proof of delivery.
 *   Only positive native evidence (the alarm notification actually
 *   visible in the drawer, checked asynchronously below) upgrades an
 *   episode to 'SENT'.
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
 * writes scheduled-alarm records ONLY through the ownership helpers in
 * criticalTransitions.ts (updateScheduledAlarm / invalidateScheduledAlarm /
 * clearScheduledAlarm), which read the authoritative active transition at
 * write time (read-only), preserve the active episode's binding, refuse
 * stale-generation writes, refuse SCHEDULED claims for SENT episodes,
 * and never generate identity — so React effect execution order between
 * the two hooks cannot produce contradictory state. Every episode-owner
 * lifecycle change made here bumps the medication's ownership revision
 * (see criticalTransitions.ts), which invalidates any async scheduler
 * operation captured before it — no late scheduler write can erase this
 * owner's binding, resurrect a dead episode's claim, or re-arm a
 * notification for a SENT episode. No artificial delays are used or
 * needed.
 *
 * == Native cancellation on foreground consumption (why HERE) ==
 * When the foreground consumes an episode's notification (NONE → SENT),
 * this hook fires a fire-and-forget cancelCriticalAlarm(med.id). At that
 * moment the med is CRITICAL, and the scheduler never arms alarms for
 * critical meds — so ANY armed critical alarm for this med is stale and
 * can only ever fire a SECOND user-facing notification for the consumed
 * episode. Cancelling here makes the consumption self-contained instead
 * of relying on the scheduler's effect re-running: the crossing may be
 * observed on a render where NO alarm-relevant med field changed (e.g.
 * the threshold was crossed by the calendar advancing while the app was
 * open across midnight — the scheduler's criticalSignature is unchanged
 * and its effect does not re-run), so the scheduler's cross-session
 * staleness cancel would never fire and the armed alarm would
 * eventually ring as a duplicate.
 *
 * This cancel is safe against in-flight scheduler operations: a
 * schedule operation that armed an alarm for the pre-crossing
 * projection re-verifies its captured ownership context AFTER the
 * native schedule resolves; the foreground send bumped the ownership
 * revision, so the stale operation compensates by cancelling the very
 * alarm it armed — the orphan cannot survive either way. The cancel is
 * also idempotent and writes NO persistent state (the claim was
 * already neutralized synchronously above).
 *
 * The owner deliberately does NOT cancel at EPISODE END (med became
 * sufficient): there the armed alarm may be the legitimate projected
 * alarm for the med's NEXT crossing, and an out-of-chain cancel could
 * race the scheduler's cancel-old→schedule-new chain and kill the NEW
 * alarm (both share the same stable per-med alarm id). Episode-end
 * cancellation is the scheduler's job — it always re-runs on episode
 * end (sufficiency only changes via refill/threshold/dose edits, all
 * of which are in its signature) and serializes cancel+reschedule
 * per-med.
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
    const ownershipRevisions = loadOwnershipRevisions();
    const dirty = { transitions: false, scheduled: false, ownership: false };
    const now = Date.now();
    /** Meds whose episode notification the foreground consumed this pass. */
    const foregroundConsumed: string[] = [];

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const effPills = effectiveCurrentPills(med);
      const isCriticalish = status === 'critical' || status === 'out_of_stock';

      const result = reconcileCriticalEpisode(
        transitions,
        scheduled,
        ownershipRevisions,
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
      if (result?.notificationSent) {
        foregroundConsumed.push(med.id);
      }
    }

    // The foreground consumed these episodes' single notification
    // opportunity — cancel any armed native critical alarm for them
    // (fire-and-forget; see the doc comment above for why this lives
    // here and why it is race-safe).
    for (const id of foregroundConsumed) {
      void cancelCriticalAlarm(id);
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
    // responsibility — it owns the native alarm cancellation and bumps
    // the ownership revision for deleted meds there.)

    if (dirty.transitions) {
      saveCriticalTransitions(transitions);
    }
    if (dirty.scheduled) {
      saveScheduledCriticalAlarms(scheduled);
    }
    if (dirty.ownership) {
      saveOwnershipRevisions(ownershipRevisions);
    }

    // ── Delivery-evidence reconciliation (strict semantics) ──
    // For episodes whose notification ownership is not yet terminal
    // ('SCHEDULED' = claim pending/consumed-window-not-yet-marked,
    // 'FIRED_OR_DUE' = claim consumed, delivery unknown), check (native
    // only, best effort) whether the scheduled alarm notification is
    // ACTUALLY visible in the Android drawer. That is positive evidence
    // of delivery; absence proves nothing and changes nothing. This
    // pass NEVER treats elapsed alarmTime as delivery.
    const hasEvidenceCandidates = medIds.some((id) => {
      const state = transitions[id]?.notificationState;
      return state === 'SCHEDULED' || state === 'FIRED_OR_DUE';
    });
    if (hasEvidenceCandidates) {
      void getDeliveredNotificationIds()
        .then((deliveredIds) => {
          // Re-load the ownership revisions AND the scheduled records
          // INSIDE this async callback: the scheduler may have written
          // records (or bumped revisions, e.g. medication deleted) while
          // the drawer query was in flight — a read-modify-write of a
          // stale map here could clobber those writes.
          const currentRevisions = loadOwnershipRevisions();
          const currentScheduled = loadScheduledCriticalAlarms();
          const changed = applyDeliveredCriticalEvidence(
            medIds,
            deliveredIds,
            transitions,
            currentScheduled,
            currentRevisions,
            criticalAlarmId
          );
          if (changed) {
            saveCriticalTransitions(transitions);
            saveScheduledCriticalAlarms(currentScheduled);
            saveOwnershipRevisions(currentRevisions);
          }
        })
        .catch(() => undefined);
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
