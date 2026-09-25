/**
 * Shared Exact Alarm × Auto-Deduction scheduling prerequisite.
 *
 * Auto-Deduction background execution is hard-gated by the Android exact
 * alarm capability. This module is the ONE pure decision point for whether
 * the Auto scheduler may arm desired occurrences, so the runtime contract
 * (and its test coverage) lives outside the React hook:
 * - global Auto OFF → cancel-and-wait regardless of exact-alarm capability;
 *   this is the durable kill switch and must remove armed Auto schedules
 * - capability unknown → wait when Global Auto is ON
 * - capability denied  → cancel-and-wait: no future Auto alarm stays armed,
 *   configuration remains intact, and the UI can surface an actionable
 *   "grant Exact Alarms" state
 * - capability granted → schedule the desired occurrences
 *
 * The platform probe itself stays centralized in the shared exact-alarm
 * capability layer (src/utils/exactAlarm.ts) — no feature-specific Android
 * permission checks. Web/iOS remain not-applicable: `unsupported` maps to
 * wait (native scheduling APIs report `not_android` there anyway).
 */
import type { ExactAlarmPermission } from './exactAlarm';

/** Explicit decision consumed by the Auto-Deduction scheduler hook. */
export type AutoDeductionSchedulingDecision =
  | { action: 'schedule' }
  | {
      /** Denial is terminal for arming: cancel tracked alarms, keep config. */
      action: 'cancel_armed_and_wait';
      reason: 'exact_alarm_permission_denied' | 'global_auto_deduct_disabled';
    }
  | {
      /** Transiently not schedulable; no destructive action. */
      action: 'wait';
      reason:
        | 'not_hydrated'
        | 'first_run'
        | 'exact_alarm_capability_unknown';
    };

export function resolveAutoDeductionSchedulingDecision(input: {
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  globalAutoDeductEnabled?: boolean | undefined;
}): AutoDeductionSchedulingDecision {
  if (!input.hydrated) {
    return { action: 'wait', reason: 'not_hydrated' };
  }
  if (input.isFirstRun) {
    return { action: 'wait', reason: 'first_run' };
  }
  if (input.globalAutoDeductEnabled === false) {
    return {
      action: 'cancel_armed_and_wait',
      reason: 'global_auto_deduct_disabled',
    };
  }
  if (input.exactAlarmPermission === null) {
    return { action: 'wait', reason: 'exact_alarm_capability_unknown' };
  }
  if (input.exactAlarmPermission === 'denied') {
    return {
      action: 'cancel_armed_and_wait',
      reason: 'exact_alarm_permission_denied',
    };
  }
  if (input.exactAlarmPermission === 'granted') {
    return { action: 'schedule' };
  }
  // 'unsupported' (web/iOS) or any future state: not applicable — nothing to
  // arm, nothing to cancel. Native scheduling APIs report not_android there.
  return { action: 'wait', reason: 'exact_alarm_capability_unknown' };
}

/**
 * True when the hook should tell the UI that Auto-Deduction scheduling is
 * explicitly blocked by the Android exact-alarm prerequisite (#500): the
 * capability is known to be DENIED — a state the user can act on via the
 * shared exact-alarm settings action.
 */
export function isAutoDeductionBlockedByExactAlarmPermission(
  exactAlarmPermission: ExactAlarmPermission | null
): boolean {
  return exactAlarmPermission === 'denied';
}
