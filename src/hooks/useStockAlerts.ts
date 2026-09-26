import { DEFAULT_MEDICATION_UNIT } from '../constants/medicationDefaults';
import { useEffect, useRef, useState } from 'react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { evaluateCriticalStockPolicy } from '../utils/criticalStockPolicy';
import { sendCriticalStockAlert } from '../utils/notifications/criticalStockNotifications';
import { cancelCriticalAlarm } from '../utils/criticalAlarmScheduling';
import {
  claimsEqual,
  getCriticalNotificationClaim,
  readCriticalNotificationClaimsOutcome,
} from '../utils/criticalNotificationClaims';
import {
  runWithCriticalNotificationClaim,
  updateCriticalNotificationClaim,
} from '../utils/criticalNotificationClaimCoordinator';
import {
  bumpCriticalAlarmGeneration,
  currentCriticalAlarmGeneration,
  enqueueCriticalAlarmOp,
  isCurrentCriticalAlarmGeneration,
} from '../utils/criticalAlarmOperations';
import { subscribeToAppResumeEvents } from '../utils/appResumeEvents';

interface UseStockAlertsOptions {
  medications: Medication[];
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
}

/**
 * Foreground Critical Stock notification fallback.
 *
 * Critical Stock has one notification opportunity per continuous critical
 * episode. Claim ownership is acquired through the cross-tab coordinator
 * before delivery; persistence failures never become silent durable state.
 *
 * Reconciliation triggers (#505): the effect re-evaluates active episodes on
 * every medication/preference change AND on every app-resume event (published
 * by the single native resume handler through the shared resume event
 * fan-out). Event-driven — no polling or timers.
 */
export function useStockAlerts({
  medications,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  // #505: resume-driven reconciliation tick. Bumped by app-resume events so
  // a failed foreground delivery is retried after capability is restored and
  // an active episode is re-evaluated even when medication state is unchanged.
  const [resumeTick, setResumeTick] = useState(0);
  useEffect(
    () =>
      subscribeToAppResumeEvents((event) => {
        if (event.isActive) setResumeTick((tick) => tick + 1);
      }),
    []
  );

  // Latest-state refs for post-await freshness revalidation (#539).
  const medicationsRef = useRef(medications);
  const enabledRef = useRef(criticalStockAlertsEnabled);
  useEffect(() => {
    medicationsRef.current = medications;
    enabledRef.current = criticalStockAlertsEnabled;
  }, [medications, criticalStockAlertsEnabled]);

  /**
   * Release ONLY an in-flight claim ({ claimed: true, alarmTime: null }) via
   * a compare-and-set update (#539). A newer operation that has already
   * converted the claim (e.g. to a scheduled claim) is never released or
   * overwritten by stale work.
   */
  const releaseInFlightClaimIfOwned = async (medId: string): Promise<void> => {
    const released = await updateCriticalNotificationClaim(
      medId,
      (current) =>
        current?.claimed && current.alarmTime === null
          ? { claimed: false, alarmTime: null }
          : current
    );
    if (!released.ok) {
      console.warn('[critical-stock] failed to release superseded foreground claim');
    }
  };

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    const claimsOutcome = readCriticalNotificationClaimsOutcome();
    if (claimsOutcome.status === 'invalid' || claimsOutcome.status === 'read_failed') {
      // Fail closed: an unreadable claim store must not drive foreground
      // delivery decisions. The scheduled background alarm remains the
      // delivery path; a later reconciliation pass retries.
      console.warn(
        `[critical-stock] claim store unusable (${claimsOutcome.status}); skipping foreground reconciliation pass.`
      );
      return;
    }
    const claims =
      claimsOutcome.status === 'ok' ? claimsOutcome.claims : {};
    const medicationIds = new Set(medications.map((med) => med.id));

    // Deleted medications cannot retain business claims. The update is
    // serialized across tabs and retried by normal reconciliation if storage
    // is temporarily unavailable.
    for (const medId of Object.keys(claims)) {
      if (!medicationIds.has(medId)) {
        const expectedClaim = claims[medId];
        if (!expectedClaim) continue;
        void updateCriticalNotificationClaim(medId, (current) =>
          claimsEqual(current, expectedClaim) ? null : current
        ).then((result) => {
          if (!result.ok) {
            console.warn('[critical-stock] failed to clear deleted-medication claim');
          }
        });
      }
    }

    const today = getTodayDateString();
    const nowMs = Date.now();

    for (const med of medications) {
      const claim = getCriticalNotificationClaim(claims, med.id);
      const decision = evaluateCriticalStockPolicy({
        medication: med,
        criticalStockAlertsEnabled,
        claim,
        todayStr: today,
        nowMs,
      });

      if (!decision.isCriticalEpisode) {
        if (claim && decision.shouldClearClaim) {
          const expectedClaim = claim;
          void updateCriticalNotificationClaim(med.id, (current) =>
            claimsEqual(current, expectedClaim) ? null : current
          ).then((result) => {
            if (!result.ok) {
              console.warn('[critical-stock] failed to clear ended-episode claim');
            }
          });

          if (claim.claimed && claim.alarmTime !== null && claim.alarmTime > Date.now()) {
            bumpCriticalAlarmGeneration(med.id);
            void enqueueCriticalAlarmOp(med.id, () => cancelCriticalAlarm(med.id));
          }
        }
        continue;
      }

      // The same policy owns foreground eligibility for an active episode.
      // A future scheduled claim remains only a recovery fallback and does
      // not suppress the foreground opportunity; an in-flight/already-sent
      // foreground claim does.
      if (!decision.foregroundEligible) continue;

      // Freshness guard (#539): capture the per-medication critical-alarm
      // generation before the async delivery. Any newer alarm operation
      // (scheduler reconciliation, cancellation) invalidates this pass.
      const generationAtStart = currentCriticalAlarmGeneration(med.id);

      // Do NOT cancel the future alarm before foreground delivery succeeds:
      // it is the recovery fallback if delivery fails (#419).
      void runWithCriticalNotificationClaim(
        med.id,
        true,
        async () => {
          // ── PRE-DELIVERY REVALIDATION (#539) ──
          // The effect snapshot (med/decision) may already be stale by the
          // time the claim is acquired. Delivery must start from the LATEST
          // durable application state, never the old render snapshot.
          //
          // The in-flight claim is owned by THIS operation while it runs:
          // acquisition + work execute inside the cross-document claim lock,
          // and same-document newer operations are gated by the generation
          // checks below.
          const latestMed = medicationsRef.current.find((m) => m.id === med.id);
          if (!latestMed || !isCurrentCriticalAlarmGeneration(med.id, generationAtStart)) {
            // Deleted, superseded, or a newer operation owns this pass.
            // Release ONLY the in-flight claim this operation still owns
            // (CAS) — never overwrite a newer claim shape.
            await releaseInFlightClaimIfOwned(med.id);
            return false;
          }
          const latestDecision = evaluateCriticalStockPolicy({
            medication: latestMed,
            criticalStockAlertsEnabled: enabledRef.current,
            claim: { claimed: true, alarmTime: null },
            todayStr: getTodayDateString(),
            nowMs: Date.now(),
          });
          if (!latestDecision.isCriticalEpisode || !latestDecision.canNotify) {
            // Refill/edit/threshold change/disable landed between the
            // render and delivery start: the episode this pass was for no
            // longer exists under the latest state. Do not deliver stale
            // content.
            await releaseInFlightClaimIfOwned(med.id);
            return false;
          }

          // Only NOW start delivery — with the LATEST medication values.
          let sent = false;
          try {
            sent = await Promise.resolve(
              sendCriticalStockAlert(
                med.id,
                latestMed.name,
                latestDecision.daysLeft,
                Number(latestMed.currentPills) || 0,
                latestMed.unit || DEFAULT_MEDICATION_UNIT
              )
            );
          } catch {
            sent = false;
          }

          if (!sent) {
            const released = await updateCriticalNotificationClaim(
              med.id,
              (current) =>
                current?.claimed && current.alarmTime === null
                  ? { claimed: false, alarmTime: null }
                  : current
            );
            if (!released.ok) {
              console.warn('[critical-stock] failed to release failed foreground claim');
            }
            return false;
          }

          // ── POST-SEND REVALIDATION (#539) ──
          // A stale foreground operation must neither keep side effects of
          // newer state nor cancel a fallback alarm created for newer
          // state. Refill/edit/delete/threshold change/disable during
          // delivery all invalidate this pass via the latest-state refs and
          // the per-medication generation.
          const freshMed = medicationsRef.current.find((m) => m.id === med.id);
          if (!isCurrentCriticalAlarmGeneration(med.id, generationAtStart) || !freshMed) {
            return true;
          }
          const freshDecision = evaluateCriticalStockPolicy({
            medication: freshMed,
            criticalStockAlertsEnabled: enabledRef.current,
            claim: { claimed: true, alarmTime: null },
            todayStr: getTodayDateString(),
            nowMs: Date.now(),
          });
          const stillOwnsEpisode =
            freshDecision.isCriticalEpisode &&
            freshDecision.canNotify;
          if (!stillOwnsEpisode) {
            // Episode ended while delivery was in flight. The claim belongs
            // to the finished episode; policy reconciliation on the newest
            // state clears it. Do not touch alarms here.
            return true;
          }

          // Cancel the now-redundant scheduled fallback. The generation is
          // re-checked INSIDE the enqueued operation as well: a newer
          // operation that bumps the generation after our post-send check
          // must never have its freshly created alarm cancelled by this
          // stale work (#539 requirement 7).
          bumpCriticalAlarmGeneration(med.id);
          const cancelGeneration = currentCriticalAlarmGeneration(med.id);
          await enqueueCriticalAlarmOp(
            med.id,
            async () => {
              if (!isCurrentCriticalAlarmGeneration(med.id, cancelGeneration)) return;
              await cancelCriticalAlarm(med.id);
            }
          );
          return true;
        }
      ).catch((error) => {
        // runWithCriticalNotificationClaim already released the in-flight
        // claim; surface unexpected work failures for diagnosis.
        console.warn('[critical-stock] foreground delivery failed:', error);
      });
    }
  }, [medications, criticalStockAlertsEnabled, hydrated, isFirstRun, resumeTick]);
}
