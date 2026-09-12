import { useEffect } from 'react';
import { Medication, calculateMedicationStatus } from '../types';
import { effectiveCurrentPills, getCriticalAlarmDate, getTodayDateString } from '../utils/dateCalculations';
import { sendCriticalStockAlert, cancelCriticalAlarm } from '../utils/notifications';
import {
  loadCriticalNotificationClaims,
  saveCriticalNotificationClaims,
  getCriticalNotificationClaim,
  setCriticalNotificationClaim,
  clearCriticalNotificationClaim,
  claimsEqual,
  enqueueCriticalAlarmOp,
} from '../utils/criticalNotificationClaims';

interface UseStockAlertsOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
}

/** The claim value an in-flight foreground send has written. */
const IN_FLIGHT_CLAIM = { claimed: true, alarmTime: null } as const;

/**
 * Foreground critical-stock notification fallback.
 *
 * Business rule (the whole point of this hook): for each medication,
 * during ONE continuous Critical/Out-of-Stock episode, the user gets AT
 * MOST ONE critical notification. The persistent claim
 * (criticalNotificationClaims.ts) is the source of truth for whether the
 * current episode already claimed it.
 *
 * Per medication, per pass:
 *
 *   sufficient / frozen         → the episode is over. Any leftover
 *                                 claim is cleared SYNCHRONOUSLY here
 *                                 (never via an async queue), so the
 *                                 next Critical episode can never
 *                                 inherit the previous episode's claim.
 *                                 Exception: the scheduler's live armed
 *                                 record { claimed: true, alarmTime: T }
 *                                 where T is EXACTLY the med's current
 *                                 projected crossing (notifications
 *                                 enabled) — that claim IS the armed
 *                                 future alarm's bookkeeping, not an
 *                                 ended episode's; touching it would
 *                                 cancel a live alarm and lose the
 *                                 future notification. Any OTHER claim
 *                                 (consumed episode, stale/moved alarm
 *                                 time, open marker) is cleared, and a
 *                                 still-future alarm time it references
 *                                 is cancelled natively (fire-and-forget
 *                                 op that writes nothing).
 *   notifications/alerts off    → for critical meds: nothing is sent and
 *                                 the claim is NEVER written (disabling
 *                                 must not consume the opportunity;
 *                                 re-enabling while still critical
 *                                 allows exactly one notification).
 *                                 The sufficient cleanup above still
 *                                 runs — clearing an ended episode's
 *                                 claim is bookkeeping, not notification.
 *   critical + claimed          → nothing. No duplicate. Covers the
 *                                 foreground send, the scheduled alarm
 *                                 whose window passed (fired while the
 *                                 app was closed, or missed — delivery
 *                                 is deliberately NOT reconstructed),
 *                                 app restarts, days passing, auto-
 *                                 deduction, manual consumption and
 *                                 Critical → Out-of-Stock (same episode).
 *   critical + claimed by a     → the alarm provably has not fired yet
 *   STILL-FUTURE alarm            (one-shot AlarmManager alarm with a
 *                                 future fire time) but the med is
 *                                 already critical (early crossing).
 *                                 Release the stale alarm and send NOW —
 *                                 still exactly one notification for the
 *                                 episode.
 *   critical + unclaimed        → send ONE foreground notification.
 *
 * Claim write timing (foreground send): the claim is marked
 * synchronously when the send starts and reverted if the send fails, so
 * re-renders while the send is in flight can never start a second send,
 * and a failed send restores the opportunity (the fallback is never
 * suppressed). After a successful foreground send any armed native alarm
 * for the med is cancelled (it could only ever fire a second
 * notification for the same claimed episode).
 *
 * Deleted medications have their claim entries removed here (the
 * scheduler cancels their native alarms).
 *
 * Race safety (all local, nothing persisted for it):
 *   - Every claim write is a synchronous load → write → save of the map
 *     (localStorage is synchronous); JS single-threading makes each
 *     write atomic.
 *   - This hook runs BEFORE useCriticalAlarmScheduler in App.tsx, so its
 *     synchronous claim decisions and its enqueued native ops always
 *     precede the scheduler's cancel/schedule chain for the same render.
 *   - The foreground writes claims only for CRITICAL meds; the scheduler
 *     only for SUFFICIENT ones — they never race on the same state.
 *   - The send resolves asynchronously; the failure-revert is a tiny
 *     CAS: if the claim moved since this pass marked it (episode ended +
 *     re-armed, med deleted, …), the revert is skipped — a stale
 *     foreground result can never overwrite newer business state.
 *   - Native alarm cancels go through the shared per-medication
 *     operation queue so they serialize against the scheduler's
 *     cancel/schedule chain.
 */
export function useStockAlerts({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  useEffect(() => {
    if (!hydrated) return;
    if (isFirstRun) return;

    const claims = loadCriticalNotificationClaims();
    let changed = false;

    // Clean up claims for deleted medications (the scheduler cancels
    // their native alarms on its side).
    const medIdSet = new Set(medications.map((m) => m.id));
    for (const id of Object.keys(claims)) {
      if (!medIdSet.has(id)) {
        clearCriticalNotificationClaim(claims, id);
        changed = true;
      }
    }

    const canNotify = notificationsEnabled && criticalStockAlertsEnabled;

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const isCriticalish = status === 'critical' || status === 'out_of_stock';

      if (!isCriticalish) {
        // ── Sufficient: this hook ends the business episode, here and
        // now, synchronously. A new Critical episode must never inherit
        // the previous episode's claim, so no async queue may own this
        // clear.
        const claim = getCriticalNotificationClaim(claims, med.id);
        if (claim) {
          const projection = canNotify
            ? getCriticalAlarmDate(med, getTodayDateString())
            : null;
          // The scheduler's live armed record: an alarm successfully
          // scheduled for EXACTLY the current projected crossing. It is
          // the future alarm's bookkeeping, not an ended episode's claim
          // — leave it alone so the armed alarm keeps its record (and
          // the scheduler's "already armed" fast path stays valid).
          const isLiveArmedRecord =
            claim.claimed &&
            claim.alarmTime !== null &&
            projection !== null &&
            claim.alarmTime === projection &&
            claim.alarmTime > Date.now();
          if (!isLiveArmedRecord) {
            clearCriticalNotificationClaim(claims, med.id);
            changed = true;
            // A still-future alarm the claim references (e.g. armed for
            // an episode that has since ended, or left armed while
            // notifications were disabled) is now stale — cancel it
            // natively. The op writes NOTHING; the claim is already
            // cleared above, and no async result may recreate it.
            if (claim.claimed && claim.alarmTime !== null && claim.alarmTime > Date.now()) {
              void enqueueCriticalAlarmOp(med.id, () => cancelCriticalAlarm(med.id));
            }
          }
        }
        continue;
      }

      // Disabled: never send, never claim. The episode logically stays
      // critical and its notification opportunity stays open.
      if (!canNotify) continue;

      const claim = getCriticalNotificationClaim(claims, med.id);
      if (claim?.claimed && (claim.alarmTime === null || claim.alarmTime <= Date.now())) {
        // This episode's notification opportunity is already consumed
        // (foreground sent, or the scheduled alarm's window passed).
        // Do nothing — at most one notification per episode.
        continue;
      }

      // Either unclaimed, or claimed by a still-future alarm (early
      // crossing — that alarm has provably not fired yet). Release the
      // stale armed alarm (if any) and send the one foreground
      // notification for this episode.
      if (claim?.claimed && claim.alarmTime !== null) {
        void enqueueCriticalAlarmOp(med.id, () => cancelCriticalAlarm(med.id));
      }

      // Mark the episode's opportunity as claimed NOW, synchronously, so
      // concurrent effect passes (any re-render re-runs this effect)
      // cannot start a second send while this one is in flight — and so
      // an app death mid-send can never produce a duplicate on the next
      // launch. A failed send reverts the mark (below).
      setCriticalNotificationClaim(claims, med.id, { ...IN_FLIGHT_CLAIM });
      changed = true;

      const effPills = effectiveCurrentPills(med);
      const unit = med.unit || 'قرص';
      Promise.resolve(sendCriticalStockAlert(med.id, med.name, daysLeft, effPills, unit))
        .then((sent) => sent === true)
        .catch(() => false)
        .then((sent) => {
          if (sent) {
            // The foreground consumed the episode's notification — make
            // sure no armed critical alarm for this med survives as a
            // second user-facing notification. Serialized through the
            // per-medication queue; idempotent.
            void enqueueCriticalAlarmOp(med.id, () => cancelCriticalAlarm(med.id));
            return;
          }
          // Send failed → un-claim so the opportunity stays available
          // (never suppress the fallback). CAS: only revert the mark we
          // ourselves wrote; if the claim moved under us (episode ended,
          // med deleted, …) the newer state wins and we do nothing.
          const fresh = loadCriticalNotificationClaims();
          const current = getCriticalNotificationClaim(fresh, med.id);
          if (!claimsEqual(current, IN_FLIGHT_CLAIM)) return;
          setCriticalNotificationClaim(fresh, med.id, { claimed: false, alarmTime: null });
          saveCriticalNotificationClaims(fresh);
        });
    }

    if (changed) {
      saveCriticalNotificationClaims(claims);
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
