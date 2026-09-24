import { useEffect } from 'react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { evaluateCriticalStockPolicy } from '../utils/criticalStockPolicy';
import { sendCriticalStockAlert } from '../utils/notifications/criticalStockNotifications';
import { cancelCriticalAlarm } from '../utils/criticalAlarmScheduling';
import {
  getCriticalNotificationClaim,
  loadCriticalNotificationClaims,
} from '../utils/criticalNotificationClaims';
import {
  runWithCriticalNotificationClaim,
  updateCriticalNotificationClaim,
} from '../utils/criticalNotificationClaimCoordinator';
import {
  bumpCriticalAlarmGeneration,
  enqueueCriticalAlarmOp,
} from '../utils/criticalAlarmOperations';

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
 */
export function useStockAlerts({
  medications,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseStockAlertsOptions): void {
  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    const claims = loadCriticalNotificationClaims();
    const medicationIds = new Set(medications.map((med) => med.id));

    // Deleted medications cannot retain business claims. The update is
    // serialized across tabs and retried by normal reconciliation if storage
    // is temporarily unavailable.
    for (const medId of Object.keys(claims)) {
      if (!medicationIds.has(medId)) {
        void updateCriticalNotificationClaim(medId, () => null).then((result) => {
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
          void updateCriticalNotificationClaim(med.id, () => null).then((result) => {
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

          bumpCriticalAlarmGeneration(med.id);
          await enqueueCriticalAlarmOp(
            med.id,
            () => cancelCriticalAlarm(med.id)
          );
          return true;
        }
      );
    }
  }, [medications, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
