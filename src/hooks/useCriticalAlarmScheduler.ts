import { DEFAULT_MEDICATION_UNIT } from '../constants/medicationDefaults';
import { useEffect, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { evaluateCriticalStockPolicy } from '../utils/criticalStockPolicy';
import {
  createCriticalSchedulingSignatureMemoizer,
} from '../utils/criticalSchedulingSignature';
import {
  scheduleCriticalAlarm,
  cancelCriticalAlarm,
  verifyCriticalAlarmPending,
} from '../utils/criticalAlarmScheduling';
import { listScheduledCriticalMedicationIdsNative } from '../utils/criticalAlarmNative';
import {
  loadCriticalNotificationClaims,
  getCriticalNotificationClaim,
} from '../utils/criticalNotificationClaims';
import type { ExactAlarmPermission } from '../utils/exactAlarm';
import { updateCriticalNotificationClaim } from '../utils/criticalNotificationClaimCoordinator';
import {
  bumpCriticalAlarmGeneration,
  currentCriticalAlarmGeneration,
  isCurrentCriticalAlarmGeneration,
  enqueueCriticalAlarmOpGuarded,
} from '../utils/criticalAlarmOperations';

/**
 * Pure Critical Stock × Exact Alarm scheduling decision (#504).
 *
 * Precedence matches the runtime effect exactly: hydration/first-run gates,
 * then the shared exact-alarm capability, then the feature preference. The
 * shared exact-alarm capability layer is the ONLY platform probe — this
 * decision is pure and contains no Android permission implementation.
 */
export type CriticalStockSchedulingDecision =
  | { action: 'schedule' }
  | {
      /** Cancel every possibly-armed alarm, keep the feature preference. */
      action: 'cancel_armed_and_wait';
      reason:
        | 'exact_alarm_permission_denied'
        | 'critical_stock_alerts_disabled';
    }
  | {
      /** Transiently not schedulable; no destructive action. */
      action: 'wait';
      reason:
        | 'not_hydrated'
        | 'first_run'
        | 'exact_alarm_capability_unknown';
    };

export function resolveCriticalStockSchedulingDecision(input: {
  hydrated: boolean;
  isFirstRun: boolean;
  criticalStockAlertsEnabled: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
}): CriticalStockSchedulingDecision {
  if (!input.hydrated) {
    return { action: 'wait', reason: 'not_hydrated' };
  }
  if (input.isFirstRun) {
    return { action: 'wait', reason: 'first_run' };
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
  if (!input.criticalStockAlertsEnabled) {
    return {
      action: 'cancel_armed_and_wait',
      reason: 'critical_stock_alerts_disabled',
    };
  }
  return { action: 'schedule' };
}

/** Explicit hook status for the UI layer (#504). */
export interface UseCriticalAlarmSchedulerStatus {
  /**
   * True when Android Exact Alarm permission is DENIED: the Critical Stock
   * preference stays intact, no future alarm is armed, foreground delivery
   * remains available, and the UI should surface the actionable
   * "grant Exact Alarms" prerequisite.
   */
  schedulingBlockedByExactAlarmPermission: boolean;
}

/**
 * Options for {@link useCriticalAlarmScheduler}.
 */
export interface UseCriticalAlarmSchedulerOptions {
  medications: Medication[];
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  /** Shared exact-alarm capability status. `unsupported` is not applicable on non-Android platforms. */
  exactAlarmPermission: ExactAlarmPermission | null;
  /**
   * Bump this counter whenever the app RESUMES to the foreground
   * (App.tsx bumps it from its appStateChange handler). Each change
   * re-runs the scheduling effect, which reconciles every matching
   * claim against the platform's actual pending notifications — this is
   * what makes "returning from the Android exact-alarm settings screen"
   * or "the native alarm disappeared while the app was backgrounded"
   * recoverable without waiting for a medication edit. The initial
   * mount (0) is the cold-start reconciliation; only RESUME events need
   * to bump it.
   */
  resumeTick?: number;
}

/**
 * One-shot critical-alarm scheduling effect.
 *
 * Role split: {@link evaluateCriticalStockPolicy} is the business decision
 * source of truth (episode boundaries, claim interpretation, delivery mode);
 * this hook is ONLY the executor that arms/cancels the native alarm and
 * persists schedule outcomes into claims. The foreground hook
 * (useStockAlerts) consumes the same policy for immediate delivery.
 *
 * Local decision semantics (canonical cross-feature contract lives in
 * docs/AUTO_DEDUCTION_ARCHITECTURE.md):
 * - CRITICAL/out_of_stock: never schedule, never write claims; cancel any
 *   alarm this session armed.
 * - SUFFICIENT with future crossing T: verify a matching claim's native
 *   alarm before trusting it; otherwise cancel + schedule; persist
 *   { claimed: true, alarmTime: T } only after a verified successful
 *   schedule; any failure writes { claimed: false, alarmTime: null } so the
 *   foreground fallback stays available.
 * - SUFFICIENT with no crossing: cancel this session's alarm; claim
 *   lifecycle is the foreground hook's decision.
 * - criticalStockAlertsEnabled false: cancel everything this session or a
 *   previous session may have armed; no claim writes.
 * - Deleted medications: alarms cancelled; claims removed by the foreground
 *   hook.
 *
 * Reconciliation: claims are business dedup state, NOT proof a native alarm
 * exists — every matching claim is verified against the platform
 * (verifyCriticalAlarmPending) and repaired (cancel + re-schedule) when
 * unverifiable. Runs on cold start, every resume (resumeTick), and every
 * alarm-relevant medication change (criticalSignature). Reconciliation never
 * sends a notification and never creates a duplicate.
 *
 * Async race safety: per-medication operation serialization +
 * generation counters (see criticalAlarmOperations) and a synchronous
 * post-schedule re-verification block before any claim write, so a stale
 * operation can never overwrite newer business state.
 */
export function useCriticalAlarmScheduler({
  medications,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmPermission,
  resumeTick = 0,
}: UseCriticalAlarmSchedulerOptions): UseCriticalAlarmSchedulerStatus {
  // Meds this session armed (or kept) an alarm for — used to cancel
  // alarms for meds that are deleted or whose projection disappears.
  const scheduledCriticalIdsRef = useRef<Set<string>>(new Set());
  // Queue + generation mechanics are centralized in the generic scheduling
  // coordinator; Critical Stock retains its business ownership here.

  /**
   * Shared cleanup for every cancel-state (#504): permission denial and
   * preference-disabled are both "no armed alarm may survive" states — the
   * session's tracked alarms, durable claims, and native-listed schedules
   * are all cancelled; feature preferences remain untouched.
   */
  const cancelAllArmedCriticalAlarms = () => {
    const ids = new Set([
      ...scheduledCriticalIdsRef.current,
      ...Object.keys(loadCriticalNotificationClaims()),
    ]);
    for (const id of ids) {
      const generation = bumpCriticalAlarmGeneration(id);
      enqueueCriticalAlarmOpGuarded(id, generation, async () => {
        await cancelCriticalAlarm(id);
      });
    }
    const staleGeneration = bumpCriticalAlarmGeneration(
      '__stale_critical_alarm_cleanup__'
    );
    enqueueCriticalAlarmOpGuarded(
      '__stale_critical_alarm_cleanup__',
      staleGeneration,
      async () => {
        const listed = await listScheduledCriticalMedicationIdsNative();
        if (!listed.ok) {
          console.warn(
            '[critical-alarm] native schedule listing failed during cleanup:',
            listed.error,
            listed.errorCode
          );
          return;
        }
        await Promise.all(
          listed.ids.map((medId) => {
            const cleanupGeneration = currentCriticalAlarmGeneration(medId);
            return enqueueCriticalAlarmOpGuarded(
              medId,
              cleanupGeneration,
              async () => {
                if (!isCurrentCriticalAlarmGeneration(medId, cleanupGeneration)) return;
                await cancelCriticalAlarm(medId);
              }
            );
          })
        );
      }
    );
    scheduledCriticalIdsRef.current.clear();
  };

  // Keep the latest medications in a ref so chained async operations can
  // re-read the CURRENT array without depending on unstable references.
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // Stable signature of every field that can change getCriticalAlarmDate()
  // (stock, rate, threshold, auto, per-med flag, schedule rows, consume/skip
  // history within the scheduling-relevant window) plus notification
  // metadata (name, unit).
  //
  // #494: signatures are memoized PER MEDICATION. A change to one medication
  // invalidates (recomputes) only that medication's fragment; unchanged
  // medications reuse their cached fragment instead of re-serializing and
  // re-sorting their entire history representation on every change. The
  // memoizer's fast path uses immutable-writer reference equality plus a
  // shallow compare of all scheduling-relevant scalars — no field that can
  // affect the projection can be skipped, and no probabilistic hashing is
  // involved. The memoizer lives in a ref so it persists across renders
  // without being a dependency of the scheduling effect.
  const signatureMemoizerRef = useRef<
    ReturnType<typeof createCriticalSchedulingSignatureMemoizer> | null
  >(null);
  if (signatureMemoizerRef.current === null) {
    signatureMemoizerRef.current = createCriticalSchedulingSignatureMemoizer();
  }
  const criticalSignature = signatureMemoizerRef.current.signature(
    medications,
    getTodayDateString()
  );

  useEffect(() => {
    // One shared decision point for the Critical Stock × Exact Alarm
    // prerequisite (#504). The shared getExactAlarmPermission() service is
    // the ONLY platform probe; this hook never implements its own Android
    // permission check.
    const decision = resolveCriticalStockSchedulingDecision({
      hydrated,
      isFirstRun,
      criticalStockAlertsEnabled,
      exactAlarmPermission,
    });
    if (decision.action !== 'schedule') {
      if (decision.action === 'cancel_armed_and_wait') {
        cancelAllArmedCriticalAlarms();
      }
      return;
    }

    const today = getTodayDateString();
    const nowMs = Date.now();
    const stillScheduled = new Set<string>();
    const claimsNow = loadCriticalNotificationClaims();

    /**
     * The cancel → schedule → verify-world → claim-write chain, shared
     * by the fresh-schedule path and the reconciliation repair path
     * (a matching claim whose native alarm could not be verified).
     */
    const runScheduleChain = async (
      medId: string,
      medName: string,
      chainCriticalDateMs: number,
      unit: string,
      gen: number
    ): Promise<void> => {
      await cancelCriticalAlarm(medId);
      if (!isCurrentCriticalAlarmGeneration(medId, gen)) return; // a newer run superseded this one

      let scheduled = false;
      try {
        const scheduleResult = await scheduleCriticalAlarm(medId, medName, chainCriticalDateMs, unit);
        if (!scheduleResult.ok) {
          console.warn('[critical-alarm] schedule failed:', scheduleResult.error, scheduleResult.errorCode);
        }
        scheduled = scheduleResult.ok;
      } catch (err) {
        console.warn('[critical-alarm] schedule failed:', err);
        scheduled = false;
      }

      // Post-schedule verification + claim write — one synchronous
      // block (no awaits between the checks and the write), so no
      // other JS code can interleave.
      if (!isCurrentCriticalAlarmGeneration(medId, gen)) {
        // A newer run superseded this operation while it awaited the
        // bridge: undo ONLY this operation's own alarm and write
        // nothing. The newer run owns the claim now.
        if (scheduled) await cancelCriticalAlarm(medId);
        return;
      }
      const currentMed = medicationsRef.current.find((m) => m.id === medId);
      if (!currentMed) {
        // Deleted while we awaited — the deletion cleanup cancels the
        // alarm; never persist a claim for a removed medication.
        if (scheduled) await cancelCriticalAlarm(medId);
        return;
      }
      const currentDecision = evaluateCriticalStockPolicy({
        medication: currentMed,
        criticalStockAlertsEnabled,
        todayStr: getTodayDateString(),
        nowMs: Date.now(),
      });
      if (
        !currentDecision.scheduledDeliveryDesired ||
        currentDecision.criticalDateMs !== chainCriticalDateMs
      ) {
        // The episode/projection changed while the bridge was in flight.
        // Cancel the alarm this operation armed and let the current policy
        // owner reconcile the newer state.
        if (scheduled) await cancelCriticalAlarm(medId);
        return;
      }

      // Claim persistence is serialized across same-origin tabs. A
      // foreground in-flight claim ({ claimed: true, alarmTime: null })
      // owns the notification opportunity and must never be overwritten by
      // this scheduler.
      const claimUpdate = await updateCriticalNotificationClaim(
        medId,
        (current) => {
          if (current?.claimed && current.alarmTime === null) return current;
          return scheduled
            ? { claimed: true, alarmTime: chainCriticalDateMs }
            : { claimed: false, alarmTime: null };
        }
      );

      if (!claimUpdate.ok) {
        console.warn('[critical-alarm] claim persistence failed');
        if (scheduled) await cancelCriticalAlarm(medId);
        return;
      }

      if (
        scheduled &&
        !(
          claimUpdate.claim?.claimed === true &&
          claimUpdate.claim.alarmTime === chainCriticalDateMs
        )
      ) {
        // Another tab/foreground owner won while this schedule was in flight.
        // Do not leave an unowned native alarm behind.
        await cancelCriticalAlarm(medId);
      }
    };

    for (const med of medicationsRef.current) {
      const gen = bumpCriticalAlarmGeneration(med.id);
      const claim = getCriticalNotificationClaim(claimsNow, med.id);
      const decision = evaluateCriticalStockPolicy({
        medication: med,
        criticalStockAlertsEnabled,
        claim,
        todayStr: today,
        nowMs,
      });

      if (!decision.scheduledDeliveryDesired) {
        // Already critical → the foreground owns the episode's
        // notification; never schedule, never write claims.
        // Sufficient but frozen (no auto deduction / no dose) → nothing
        // will cross the threshold without user action.
        // Claim lifecycle is NOT this hook's job: an armed alarm that is
        // no longer wanted is cancelled below, but ending the episode
        // (clearing the claim) is useStockAlerts' synchronous decision.
        const hadAlarm = scheduledCriticalIdsRef.current.has(med.id);
        if (hadAlarm) {
          const medId = med.id;
          enqueueCriticalAlarmOpGuarded(medId, gen, async () => {
            if (!isCurrentCriticalAlarmGeneration(medId, gen)) return;
            await cancelCriticalAlarm(medId);
          });
        }
        continue;
      }

      // Sufficient with a future projected crossing at criticalDateMs.
      stillScheduled.add(med.id);

      const criticalDateMs = decision.criticalDateMs;
      if (criticalDateMs === null) {
        continue;
      }

      const medId = med.id;
      const medName = med.name;
      const unit = med.unit || DEFAULT_MEDICATION_UNIT;

      if (decision.scheduledDeliveryBlockedByForeground) {
        // Foreground Critical Stock delivery owns this opportunity while the
        // send is in flight. Never arm a competing future fallback.
        continue;
      }

      if (decision.matchingScheduledClaim) {
        // The claim says the alarm is armed exactly here. A claim is
        // business dedup state — it does NOT prove the native alarm
        // still exists (Android can drop previously-scheduled alarms:
        // SCHEDULE_EXACT_ALARM revoked, force-stop, OEM kills, the
        // notification otherwise removed). Verify before trusting:
        // verified → keep it (no re-arm, no duplicate); unverifiable or
        // missing → run the repair chain (cancel + re-schedule) whose
        // outcome writes the claim exactly like any fresh schedule.
        enqueueCriticalAlarmOpGuarded(medId, gen, async () => {
          if (!isCurrentCriticalAlarmGeneration(medId, gen)) return;
          const verification = await verifyCriticalAlarmPending(medId, criticalDateMs);
          if (
            (verification.ok && verification.pending) ||
            !isCurrentCriticalAlarmGeneration(medId, gen)
          ) return;
          if (!verification.ok) {
            console.warn(
              '[critical-alarm] verify failed:',
              verification.error,
              verification.errorCode
            );
          }
          await runScheduleChain(medId, medName, criticalDateMs, unit, gen);
        });
        continue;
      }

      enqueueCriticalAlarmOpGuarded(medId, gen, () =>
        runScheduleChain(medId, medName, criticalDateMs, unit, gen)
      );
    }

    // Cancel alarms for meds that are no longer present (deleted).
    for (const prevId of scheduledCriticalIdsRef.current) {
      if (!stillScheduled.has(prevId)) {
        const generation = bumpCriticalAlarmGeneration(prevId);
        enqueueCriticalAlarmOpGuarded(prevId, generation, async () => {
          await cancelCriticalAlarm(prevId);
        });
      }
    }
    scheduledCriticalIdsRef.current = stillScheduled;

    // Native durable schedule state is also reconciled so a critical alarm
    // left behind after medication deletion or process death cannot survive
    // merely because its old business claim is absent.
    const staleGeneration = bumpCriticalAlarmGeneration(
      '__stale_critical_alarm_cleanup__'
    );
    enqueueCriticalAlarmOpGuarded(
      '__stale_critical_alarm_cleanup__',
      staleGeneration,
      async () => {
        const listed = await listScheduledCriticalMedicationIdsNative();
        if (!listed.ok) {
          console.warn(
            '[critical-alarm] native schedule listing failed:',
            listed.error,
            listed.errorCode
          );
          return;
        }
        await Promise.all(
          listed.ids
            .filter((medId) => !stillScheduled.has(medId))
            .map((medId) => {
              const cleanupGeneration = currentCriticalAlarmGeneration(medId);
              return enqueueCriticalAlarmOpGuarded(
                medId,
                cleanupGeneration,
                async () => {
                if (!isCurrentCriticalAlarmGeneration(medId, cleanupGeneration)) return;
                await cancelCriticalAlarm(medId);
              });
            })
        );
      }
    );
  }, [
    criticalSignature,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
    resumeTick,
    exactAlarmPermission,
  ]);

  return {
    schedulingBlockedByExactAlarmPermission:
      exactAlarmPermission === 'denied',
  };
}
