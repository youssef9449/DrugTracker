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
          let sent = false;
          try {
            const currentPills = Number(med.currentPills) || 0;
            const unit = med.unit || 'قرص';
            sent = await Promise.resolve(
              sendCriticalStockAlert(
                med.id,
                med.name,
                decision.daysLeft,
                currentPills,
                unit
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

          // Freshness revalidation after the await (#539): a stale foreground
          // operation must neither deliver post-send side effects nor cancel
          // the alarm desired by NEWER state. Refill/edit/delete/threshold
          // change/disable during delivery all invalidate this pass via the
          // latest-state refs and the per-medication generation.
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

          bumpCriticalAlarmGeneration(med.id);
          await enqueueCriticalAlarmOp(
            med.id,
            () => cancelCriticalAlarm(med.id)
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
