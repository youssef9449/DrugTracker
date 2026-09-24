import type { CriticalNotificationClaim, Medication, MedicationStatus } from '../types';
import { calculateMedicationStatus } from './medicationStatus';
import { getCriticalAlarmDate, getTodayDateString } from './dateCalculations';

export type CriticalStockDelivery = 'none' | 'foreground' | 'scheduled';

export type CriticalStockClaimState =
  | 'absent'
  | 'foreground-in-flight'
  | 'foreground-consumed'
  | 'scheduled-current'
  | 'scheduled-stale';

export interface CriticalStockPolicyInput {
  medication: Medication;
  criticalStockAlertsEnabled: boolean;
  claim?: CriticalNotificationClaim | null;
  todayStr?: string;
  nowMs?: number;
}

export interface CriticalStockPolicyDecision {
  status: MedicationStatus;
  daysLeft: number;
  isCriticalEpisode: boolean;
  canNotify: boolean;
  criticalDateMs: number | null;
  desiredDelivery: CriticalStockDelivery;
  foregroundEligible: boolean;
  scheduledDeliveryDesired: boolean;
  scheduledDeliveryBlockedByForeground: boolean;
  claimState: CriticalStockClaimState;
  shouldClearClaim: boolean;
  matchingScheduledClaim: boolean;
}

/**
 * Single business decision model for Critical Stock delivery.
 *
 * Both foreground fallback and scheduled delivery consume this same decision.
 * The policy owns episode boundaries, notification eligibility, projected
 * crossing semantics, and interpretation of the persisted claim. Persistence
 * itself remains owned by the claim coordinator, and native AlarmManager
 * mechanics remain outside this module.
 */
export function evaluateCriticalStockPolicy({
  medication,
  criticalStockAlertsEnabled,
  claim = null,
  todayStr = getTodayDateString(),
  nowMs = Date.now(),
}: CriticalStockPolicyInput): CriticalStockPolicyDecision {
  const { status, daysLeft } = calculateMedicationStatus(medication);
  const isCriticalEpisode =
    status === 'critical' || status === 'out_of_stock';
  const canNotify =
    criticalStockAlertsEnabled && medication.criticalStockAlertsEnabled === true;
  const criticalDateMs = canNotify
    ? getCriticalAlarmDate(medication, todayStr, nowMs)
    : null;

  const claimState: CriticalStockClaimState = !claim
    ? 'absent'
    : claim.claimed && claim.alarmTime === null
      ? 'foreground-in-flight'
      : claim.claimed && claim.alarmTime !== null && criticalDateMs !== null
        && claim.alarmTime === criticalDateMs
        && claim.alarmTime > nowMs
        ? 'scheduled-current'
        : claim.claimed
          ? claim.alarmTime !== null && claim.alarmTime <= nowMs
            ? 'foreground-consumed'
            : 'scheduled-stale'
          : 'absent';

  const foregroundEligible =
    canNotify &&
    isCriticalEpisode &&
    !(
      claim?.claimed === true &&
      (claim.alarmTime === null || claim.alarmTime <= nowMs)
    );

  const scheduledDeliveryDesired =
    canNotify && !isCriticalEpisode && criticalDateMs !== null;
  const scheduledDeliveryBlockedByForeground =
    scheduledDeliveryDesired &&
    claim?.claimed === true &&
    claim.alarmTime === null;

  const desiredDelivery: CriticalStockDelivery =
    foregroundEligible
      ? 'foreground'
      : scheduledDeliveryDesired
        ? 'scheduled'
        : 'none';

  const matchingScheduledClaim =
    scheduledDeliveryDesired &&
    claim?.claimed === true &&
    claim.alarmTime === criticalDateMs;

  // A claim belongs to a continuous critical episode. Once the medication
  // returns to a sufficient state, only a currently-valid future alarm claim
  // survives; every other stale claim is released so the next critical
  // episode gets a fresh notification opportunity.
  const shouldClearClaim =
    !isCriticalEpisode &&
    claim !== null &&
    !matchingScheduledClaim;

  return {
    status,
    daysLeft,
    isCriticalEpisode,
    canNotify,
    criticalDateMs,
    desiredDelivery,
    foregroundEligible,
    scheduledDeliveryDesired,
    scheduledDeliveryBlockedByForeground,
    claimState,
    shouldClearClaim,
    matchingScheduledClaim,
  };
}
