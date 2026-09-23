import { useEffect } from 'react';
import type { Medication } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import { getCriticalAlarmDate, getTodayDateString } from '../utils/dateCalculations';
import { sendCriticalStockAlert } from '../utils/notifications/criticalStockNotifications';
import { cancelCriticalAlarm } from '../utils/criticalAlarmScheduling';
import {
  getCriticalNotificationClaim,
  loadCriticalNotificationClaims,
} from '../utils/criticalNotificationClaims';
import {
  releaseInFlightCriticalNotificationClaim,
  tryClaimCriticalNotification,
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

    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      const isCriticalish = status === 'critical' || status === 'out_of_stock';
      const canNotify =
        criticalStockAlertsEnabled && med.criticalStockAlertsEnabled !== false;

      if (!isCriticalish) {
        const claim = getCriticalNotificationClaim(claims, med.id);
        const projection = canNotify
          ? getCriticalAlarmDate(med, getTodayDateString())
          : null;
        const isLiveArmedRecord =
          claim?.claimed === true &&
          claim.alarmTime !== null &&
          projection !== null &&
          claim.alarmTime === projection &&
          claim.alarmTime > Date.now();

        if (claim && !isLiveArmedRecord) {
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

      // Disabling Critical Stock notifications never consumes the episode's
      // notification opportunity.
      if (!canNotify) continue;

      const claim = getCriticalNotificationClaim(claims, med.id);
      if (claim?.claimed && (claim.alarmTime === null || claim.alarmTime <= Date.now())) {
        continue;
      }

      // A still-future scheduled claim is not allowed to suppress the
      // foreground notification when the medication has already crossed.
      // Do NOT cancel the future alarm before foreground delivery succeeds:
      // it is the recovery fallback if delivery fails (#419).
      void (async () => {
        const acquired = await tryClaimCriticalNotification(med.id, true);
        if (!acquired) return;

        let sent = false;
        try {
          const currentPills = Number(med.currentPills) || 0;
          const unit = med.unit || 'قرص';
          sent = await Promise.resolve(
            sendCriticalStockAlert(
              med.id,
              med.name,
              daysLeft,
              currentPills,
              unit
            )
          );
        } catch {
          sent = false;
        }

        if (!sent) {
          const released = await releaseInFlightCriticalNotificationClaim(med.id);
          if (!released) {
            console.warn('[critical-stock] failed to release failed foreground claim');
          }
          return;
        }

        // The notification is accepted first. Only now invalidate and cancel
        // the future scheduled fallback. A cancellation failure remains
        // protected by the native operation-version/tombstone boundary and
        // will be retried by reconciliation.
        bumpCriticalAlarmGeneration(med.id);
        await enqueueCriticalAlarmOp(
          med.id,
          () => cancelCriticalAlarm(med.id)
        );
      })();
    }
  }, [medications, criticalStockAlertsEnabled, hydrated, isFirstRun]);
}
