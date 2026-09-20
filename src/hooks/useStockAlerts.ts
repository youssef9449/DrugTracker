import { useEffect, useRef } from 'react';
import { Medication, calculateMedicationStatus } from '../types';
import { getCriticalAlarmDate, getTodayDateString } from '../utils/dateCalculations';
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
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
}

/** The claim value an in-flight foreground send has written. */
const IN_FLIGHT_CLAIM = { claimed: true, alarmTime: null } as const;

/**
 * Module-level per-medication Critical episode generation.
 *
 * Advances when the business episode changes:
 *   sufficient/non-critical → Critical/Out-of-Stock
 *   Critical/Out-of-Stock → sufficient/non-critical
 *   medication deleted
 *   medication removed and later recreated with the same id
 *
 * Does NOT increment on ordinary re-renders while the med stays in the
 * same business state. Used so a stale foreground send success/failure
 * from an earlier episode cannot cancel a newer episode's alarm or clear
 * a newer in-flight claim. claimsEqual alone cannot distinguish two
 * legitimate { claimed: true, alarmTime: null } markers from different
 * episodes.
 */
const episodeGenerationByMedId = new Map<string, number>();
const lastCriticalishByMedId = new Map<string, boolean>();

function advanceEpisodeGeneration(medId: string): number {
  const next = (episodeGenerationByMedId.get(medId) ?? 0) + 1;
  episodeGenerationByMedId.set(medId, next);
  return next;
}

function currentEpisodeGeneration(medId: string): number {
  return episodeGenerationByMedId.get(medId) ?? 0;
}

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
 *                                 enabled) — that claim is the future
 *                                 alarm's bookkeeping, not an ended
 *                                 episode's; touching it would fight
 *                                 the scheduler's verified fast path
 *                                 (which re-checks the claim against
 *                                 the platform's actual pending
 *                                 alarms before trusting it). Any
 *                                 OTHER claim (consumed episode,
 *                                 stale/moved alarm time, open marker)
 *                                 is cleared, and a still-future alarm
 *                                 time it references is cancelled
 *                                 natively (fire-and-forget op that
 *                                 writes nothing).
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
 * for the med is cancelled only when the success still belongs to the
 * same Critical episode (generation + claim + criticalish state).
 *
 * Deleted medications: claims are read first; if alarmTime is non-null
 * a native cancel is enqueued (writes nothing to claims), then the claim
 * entry is removed synchronously. Cold start has empty scheduler memory;
 * the persisted claim is sufficient to discover and cancel a previously
 * armed future Critical alarm.
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
 *   - Episode generation + claim CAS ensure a stale foreground result
 *     can never overwrite newer business state or cancel a newer episode's
 *     alarm.
 *   - Native alarm cancels go through the shared per-medication
 *     operation queue so they serialize against the scheduler's
 *     cancel/schedule chain.
 */
export function useStockAlerts({
  medications,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  // Track med ids present on the previous effect run so delete/recreate
  // of the same id advances episode generation.
  const prevMedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!hydrated) return;
    if (isFirstRun) return;

    const claims = loadCriticalNotificationClaims();
    let changed = false;

    const medIdSet = new Set(medications.map((m) => m.id));

    // Clean up claims for deleted medications. Read claim FIRST; if it
    // records a future alarm, enqueue cancel (no claim writes), then
    // remove the claim entry synchronously. Scheduler in-memory state is
    // not required — cold start starts with empty scheduledCriticalIdsRef.
    for (const id of Object.keys(claims)) {
      if (!medIdSet.has(id)) {
        const claim = getCriticalNotificationClaim(claims, id);
        if (
          claim?.claimed &&
          claim.alarmTime !== null &&
          claim.alarmTime > Date.now()
        ) {
          void enqueueCriticalAlarmOp(id, () => cancelCriticalAlarm(id));
        }
        clearCriticalNotificationClaim(claims, id);
        changed = true;
        // Deleted med: advance (or clear) episode tracking so a later
        // recreate with the same id is a new episode.
        lastCriticalishByMedId.delete(id);
        advanceEpisodeGeneration(id);
      }
    }

    // App preference for critical-stock alerts only (independent of dose reminders).
    // OS permission is enforced inside the notification utility on send.
    const canNotify = criticalStockAlertsEnabled;

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const isCriticalish = status === 'critical' || status === 'out_of_stock';

      // Advance episode generation on business-state transitions only.
      const prevCriticalish = lastCriticalishByMedId.get(med.id);
      if (prevCriticalish === undefined) {
        // First sighting this session (or after delete): seed without
        // forcing a generation bump on ordinary re-entry while critical.
        lastCriticalishByMedId.set(med.id, isCriticalish);
        if (isCriticalish && !episodeGenerationByMedId.has(med.id)) {
          advanceEpisodeGeneration(med.id);
        }
      } else if (prevCriticalish !== isCriticalish) {
        lastCriticalishByMedId.set(med.id, isCriticalish);
        advanceEpisodeGeneration(med.id);
      }

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
          // — leave it alone. (The claim itself is not proof the native
          // alarm exists; the scheduler's fast path VERIFIES it against
          // the platform's pending notifications on every run and
          // re-arms it when the OS dropped it.)
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

      // Capture episode identity for this send so a stale success/failure
      // cannot affect a newer episode after this one ends.
      const sendGeneration = currentEpisodeGeneration(med.id);
      const inFlightMarker = { ...IN_FLIGHT_CLAIM };

      const currentPills = Number(med.currentPills) || 0;
      const unit = med.unit || 'قرص';
      Promise.resolve(sendCriticalStockAlert(med.id, med.name, daysLeft, currentPills, unit))
        .then((sent) => sent === true)
        .catch(() => false)
        .then((sent) => {
          if (sent) {
            // Cancel native alarm ONLY when this success still belongs to
            // the same Critical episode: med exists, still criticalish,
            // generation matches, claim still the in-flight marker we wrote.
            void enqueueCriticalAlarmOp(med.id, async () => {
              const freshMedsClaim = loadCriticalNotificationClaims();
              const currentClaim = getCriticalNotificationClaim(freshMedsClaim, med.id);
              if (!claimsEqual(currentClaim, inFlightMarker)) return;
              if (currentEpisodeGeneration(med.id) !== sendGeneration) return;
              // Re-read criticalish from last known business state map
              // (hook owns episode lifecycle; generation advances on leave).
              if (lastCriticalishByMedId.get(med.id) !== true) return;
              if (currentEpisodeGeneration(med.id) !== sendGeneration) return;
              await cancelCriticalAlarm(med.id);
            });
            return;
          }
          // Send failed → un-claim so the opportunity stays available
          // (never suppress the fallback). Episode-aware CAS: only revert
          // when claim and generation still match this send — a stale
          // failure from Episode A must not clear Episode B's claim.
          if (currentEpisodeGeneration(med.id) !== sendGeneration) return;
          const fresh = loadCriticalNotificationClaims();
          const current = getCriticalNotificationClaim(fresh, med.id);
          if (!claimsEqual(current, inFlightMarker)) return;
          if (currentEpisodeGeneration(med.id) !== sendGeneration) return;
          setCriticalNotificationClaim(fresh, med.id, { claimed: false, alarmTime: null });
          saveCriticalNotificationClaims(fresh);
        });
    }

    // Drop tracking for meds no longer present (already handled claims above).
    for (const id of prevMedIdsRef.current) {
      if (!medIdSet.has(id)) {
        lastCriticalishByMedId.delete(id);
      }
    }
    prevMedIdsRef.current = medIdSet;

    if (changed) {
      saveCriticalNotificationClaims(claims);
    }
  }, [medications, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}

/** Test-only helpers for episode-generation regressions. */
export function __getEpisodeGenerationForTests(medId: string): number {
  return currentEpisodeGeneration(medId);
}
export function __resetEpisodeGenerationForTests(): void {
  episodeGenerationByMedId.clear();
  lastCriticalishByMedId.clear();
}
