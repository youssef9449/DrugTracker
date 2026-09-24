import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString, dailyScheduleAmount } from '../utils/dateCalculations';
import { evaluateCriticalStockPolicy } from '../utils/criticalStockPolicy';
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
 * For each SUFFICIENT medication whose projected critical date is in the
 * future, schedules a SINGLE one-shot exact alarm at that date through
 * CriticalStockAlarmAdapter → ExactAlarmRuntime. The alarm fires
 * even if the app is killed; system lifecycle recovery is handled by
 * DrugTrackerAlarmSystemReceiver → ExactAlarmLifecycle.
 *
 * The persistent claim ({@link CriticalNotificationClaim}) is the
 * business source of truth; this hook is just the EXECUTOR that arms and
 * cancels the native alarm and records the claim after a successful
 * schedule. It never decides whether the user has been notified for an
 * active critical episode — that is the foreground hook's job.
 *
 * Decision table (per med, per effect run):
 *
 *   Med CRITICAL / out_of_stock:
 *     NEVER schedule (the foreground hook owns the active episode's
 *     notification), never write claims for it. Any alarm this session
 *     armed for the med (it was sufficient when armed) is cancelled.
 *
 *   Med SUFFICIENT with a future projected crossing at T:
 *     claim matches { claimed: true, alarmTime: T } → VERIFY the native
 *       alarm actually exists (verifyCriticalAlarmPending): verified →
 *       keep it, nothing to do; unverifiable/missing → the repair chain
 *       below re-arms it (cancel + schedule); success → the claim stays
 *       { claimed: true, alarmTime: T }, failure → { claimed: false,
 *       alarmTime: null } so the foreground fallback stays available.
 *     otherwise → cancel the previous alarm, schedule at T; on success
 *       persist { claimed: true, alarmTime: T } — ONLY after
 *       scheduleCriticalAlarm() resolves successfully (which now also
 *       requires the plugin's ScheduleResult to actually list the
 *       notification); on failure persist { claimed: false,
 *       alarmTime: null } so the foreground fallback stays available.
 *       A failed schedule NEVER suppresses the fallback.
 *
 *   Med SUFFICIENT with no future crossing (frozen: auto-deduct off, or
 *   dailyDose <= 0):
 *     cancel any alarm this session armed — nothing will cross the
 *     threshold without user action. The claim is NOT touched here:
 *     ending the business episode (clearing the claim) is the foreground
 *     hook's synchronous job (useStockAlerts).
 *
 *   criticalStockAlertsEnabled false:
 *     cancel every possibly-armed critical alarm (this session's and any
 *     left over from a previous session, found via the claim map). No
 *     claim writes — the claim's business lifecycle belongs to
 *     useStockAlerts (a Sufficient med's claim is cleared there
 *     synchronously; re-enabling re-arms from a clean slate).
 *     Dose-reminder preference (notificationsEnabled) does not gate
 *     critical alarms.
 *
 *   Deleted medications: their alarms are cancelled (their claim entries
 *   are removed by the foreground hook).
 *
 * OWNERSHIP (important): this hook is the native-alarm EXECUTOR only.
 * It never ends a business episode and never clears the persistent
 * claim because a medication became Sufficient/frozen/disabled — that
 * transition is owned, synchronously, by useStockAlerts. The only claim
 * writes here are the schedule outcome for a SUFFICIENT med with a
 * future crossing: success → { claimed: true, alarmTime: T }, failure →
 * { claimed: false, alarmTime: null } (opportunity stays open).
 *
 * RECONCILIATION ("armed" is verified, never assumed): the persistent
 * claim is business DEDUP state — it does NOT prove the native alarm
 * still exists. Android can drop previously-scheduled alarms
 * (SCHEDULE_EXACT_ALARM revoked, force-stop, OEM task killers, the
 * scheduled notification otherwise removed), so a matching claim is
 * verified against the platform (verifyCriticalAlarmPending:
 * display permission + exact-alarm setting + the plugin's pending
 * list — see that function for the exact guarantees and their
 * documented platform limits). Verified → keep (no re-arm, no
 * duplicate). Unverifiable or missing → cancel + re-schedule; a
 * successful repair re-establishes the evidence, a failed repair opens
 * the claim so the foreground fallback remains available. Reconciliation
 * runs on every effect run: cold start (initial mount), every resume
 * (resumeTick — returning from the exact-alarm settings screen re-arms
 * what the OS dropped), and every alarm-relevant medication change.
 * Reconciliation NEVER sends a user-facing notification and NEVER
 * creates a duplicate: it only cancels/schedules native alarms under
 * the one stable id and writes the same two claim shapes as any other
 * schedule outcome.
 *
 * Re-schedule triggers: the effect re-runs whenever any field that
 * affects the projected critical date changes (id, currentPills,
 * dailyDose, warningThresholdDays, autoDeductEnabled,
 * name, unit) — see `criticalSignature`.
 *
 * Async race safety (all in-memory, nothing persisted for it):
 *   - Per-medication serialization: every native cancel/schedule runs on
 *     the shared per-medication operation queue
 *     (OperationQueue), so operations for one medication never
 *     interleave (they share one stable native notification id).
 *   - Generation counter: each effect run bumps a per-med generation; a
 *     chained operation captures its generation and abandons everything
 *     (cancelling only its own just-armed alarm, writing nothing) when a
 *     newer run superseded it while it awaited the bridge.
 *   - Post-schedule re-verification (one synchronous block, before any
 *     claim write): the medication must still exist, still be
 *     sufficient, and still project the SAME critical date. If the world
 *     moved (episode started/ended, med edited/deleted), the operation
 *     cancels the alarm it just armed and leaves the claim to the
 *     current owner — a stale operation can never overwrite newer
 *     business state or resurrect a dead episode's alarm.
 */
export function useCriticalAlarmScheduler({
  medications,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmPermission,
  resumeTick = 0,
}: UseCriticalAlarmSchedulerOptions): void {
  // Meds this session armed (or kept) an alarm for — used to cancel
  // alarms for meds that are deleted or whose projection disappears.
  const scheduledCriticalIdsRef = useRef<Set<string>>(new Set());
  // Queue + generation mechanics are centralized in the generic scheduling
  // coordinator; Critical Stock retains its business ownership here.

  // Keep the latest medications in a ref so chained async operations can
  // re-read the CURRENT array without depending on unstable references.
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // Stable signature of every field that can change getCriticalAlarmDate()
  // (stock, threshold, auto, explicit schedule rows, consume/skip history).
  // Deterministic serialization avoids false churn from object key order.
  const criticalSignature = useMemo(() => {
    const serializeHistory = (
      hist: Record<string, string[]> | undefined,
      doseIds: string[]
    ): string => {
      if (!hist || doseIds.length === 0) return '';
      return doseIds
        .map((id) => {
          const dates = hist[id];
          if (!Array.isArray(dates) || dates.length === 0) return `${id}:`;
          // Sort dates so insertion order does not affect the signature.
          const sorted = [...dates].filter((d) => typeof d === 'string' && d).sort();
          return `${id}:${sorted.join(',')}`;
        })
        .join(';');
    };

    const serializeSchedule = (
      schedule: Medication['doseSchedule']
    ): { schedulePart: string; doseIds: string[] } => {
      if (!Array.isArray(schedule) || schedule.length === 0) {
        return { schedulePart: '', doseIds: [] };
      }
      const rows = schedule
        .map((d) => ({
          id: d?.id != null ? String(d.id) : '',
          amount: Number(d?.amount) || 0,
          time: typeof d?.time === 'string' ? d.time : '',
        }))
        // Deterministic order by time then id (not array index).
        .sort((a, b) => {
          const t = a.time.localeCompare(b.time);
          return t !== 0 ? t : a.id.localeCompare(b.id);
        });
      const doseIds = rows.map((r) => r.id).filter(Boolean);
      const schedulePart = rows
        .map((r) => `${r.id}@${r.time}=${r.amount}`)
        .join(',');
      return { schedulePart, doseIds };
    };

    return medications
      .map((m) => {
        const { schedulePart, doseIds } = serializeSchedule(m.doseSchedule);
        return [
          m.id,
          m.currentPills,
          m.dailyDose,
          dailyScheduleAmount(m),
          m.warningThresholdDays,
          m.autoDeductEnabled === false ? 0 : 1,
          m.criticalStockAlertsEnabled === true ? 1 : 0,
          m.name,
          m.unit ?? '',
          schedulePart,
          serializeHistory(m.doseConsumptionHistory, doseIds),
          serializeHistory(m.doseSkippedHistory, doseIds),
        ].join('|');
      })
      .sort()
      .join('\n');
  }, [medications]);

  useEffect(() => {
    if (!hydrated || isFirstRun) return;
    // Android exact-alarm scheduling is fail-closed when the shared permission
    // service reports denied. `unsupported` means the Android permission model
    // is not applicable (for example iOS/web), so those platforms keep their
    // existing notification scheduling behavior.
    if (exactAlarmPermission === null) return;

    // Exact-alarm permission loss is a cleanup state, not an empty state.
    // Android removes exact alarms when permission is revoked, but durable
    // feature metadata still needs deterministic reconciliation before a
    // later permission grant can restore only the currently desired alarms.
    if (exactAlarmPermission === 'denied') {
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
              '[critical-alarm] native schedule listing failed during permission cleanup:',
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
      return;
    }

    // ── Flags disabled: cancel every possibly-armed alarm ──
    // ── (claim writes belong to the foreground hook) ──
    // Gated only by critical-stock preference (independent of dose reminders).
    if (!criticalStockAlertsEnabled) {
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
            console.warn('[critical-alarm] native schedule listing failed:', listed.error, listed.errorCode);
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
              });
            })
          );
        }
      );
      scheduledCriticalIdsRef.current.clear();
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
      const unit = med.unit || 'قرص';

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
}
