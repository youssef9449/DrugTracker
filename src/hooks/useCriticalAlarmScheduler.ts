import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { calculateMedicationStatus } from '../types';
import { getTodayDateString, getCriticalAlarmDate } from '../utils/dateCalculations';
import {
  scheduleCriticalAlarm,
  cancelCriticalAlarm,
  verifyCriticalAlarmPending,
} from '../utils/notifications';
import {
  loadCriticalNotificationClaims,
  saveCriticalNotificationClaims,
  getCriticalNotificationClaim,
  setCriticalNotificationClaim,
  enqueueCriticalAlarmOp,
} from '../utils/criticalNotificationClaims';

/**
 * Options for {@link useCriticalAlarmScheduler}.
 */
export interface UseCriticalAlarmSchedulerOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
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
 * future, schedules a SINGLE one-shot notification at that date via
 * Android's AlarmManager (Capacitor LocalNotifications). The alarm fires
 * even if the app is killed — the user sees the alert in their drawer at
 * the projected critical date without ever opening the app. On Android,
 * the plugin persists scheduled notifications and re-arms them on
 * BOOT_COMPLETED, so alarms survive device reboots with no extra code.
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
 *   Flags disabled (either notificationsEnabled or
 *   criticalStockAlertsEnabled false):
 *     cancel every possibly-armed critical alarm (this session's and any
 *     left over from a previous session, found via the claim map). No
 *     claim writes — the claim's business lifecycle belongs to
 *     useStockAlerts (a Sufficient med's claim is cleared there
 *     synchronously; re-enabling re-arms from a clean slate).
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
 * dailyDose, lastSyncDate, warningThresholdDays, autoDeductEnabled,
 * name, unit) — see `criticalSignature`.
 *
 * Async race safety (all in-memory, nothing persisted for it):
 *   - Per-medication serialization: every native cancel/schedule runs on
 *     the shared per-medication operation queue
 *     (enqueueCriticalAlarmOp), so operations for one medication never
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
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
  resumeTick = 0,
}: UseCriticalAlarmSchedulerOptions): void {
  // Meds this session armed (or kept) an alarm for — used to cancel
  // alarms for meds that are deleted or whose projection disappears.
  const scheduledCriticalIdsRef = useRef<Set<string>>(new Set());
  // In-memory per-med generation counter for stale-async protection.
  const alarmGenerationRef = useRef<Map<string, number>>(new Map());

  // Keep the latest medications in a ref so chained async operations can
  // re-read the CURRENT array without depending on unstable references.
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // Stable signature capturing ONLY the fields that affect the critical
  // alarm date (per getCriticalAlarmDate + scheduleCriticalAlarm), so the
  // cancel+schedule chains re-run only when a med's alarm-relevant
  // config actually changes.
  const criticalSignature = useMemo(
    () =>
      medications
        .map((m) =>
          [
            m.id,
            m.currentPills,
            m.dailyDose,
            m.lastSyncDate ?? '',
            m.warningThresholdDays,
            m.autoDeductEnabled === false ? 0 : 1,
            m.name,
            m.unit ?? '',
          ].join('|')
        )
        .sort()
        .join('\n'),
    [medications]
  );

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    /** Bump + return this run's generation for a med. */
    const nextGeneration = (medId: string): number => {
      const gen = (alarmGenerationRef.current.get(medId) ?? 0) + 1;
      alarmGenerationRef.current.set(medId, gen);
      return gen;
    };
    const currentGeneration = (medId: string): number =>
      alarmGenerationRef.current.get(medId) ?? 0;

    // ── Flags disabled: cancel every possibly-armed alarm ──
    // ── (claim writes belong to the foreground hook) ──
    if (!notificationsEnabled || !criticalStockAlertsEnabled) {
      const ids = new Set([
        ...scheduledCriticalIdsRef.current,
        ...Object.keys(loadCriticalNotificationClaims()),
      ]);
      for (const id of ids) {
        nextGeneration(id);
        enqueueCriticalAlarmOp(id, async () => {
          await cancelCriticalAlarm(id);
        });
      }
      scheduledCriticalIdsRef.current.clear();
      return;
    }

    const today = getTodayDateString();
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
      if (currentGeneration(medId) !== gen) return; // a newer run superseded this one

      let scheduled = false;
      try {
        scheduled =
          (await scheduleCriticalAlarm(medId, medName, chainCriticalDateMs, unit)) === true;
      } catch (err) {
        console.warn('[critical-alarm] schedule failed:', err);
        scheduled = false;
      }

      // Post-schedule verification + claim write — one synchronous
      // block (no awaits between the checks and the write), so no
      // other JS code can interleave.
      if (currentGeneration(medId) !== gen) {
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
      const { status: currentStatus } = calculateMedicationStatus(currentMed);
      if (currentStatus === 'critical' || currentStatus === 'out_of_stock') {
        // The medication crossed while we awaited — the foreground
        // hook now owns the episode's notification. Cancel the alarm
        // this operation armed and write nothing.
        if (scheduled) await cancelCriticalAlarm(medId);
        return;
      }
      if (getCriticalAlarmDate(currentMed, getTodayDateString()) !== chainCriticalDateMs) {
        // The projection moved — a newer run will arm the right alarm.
        if (scheduled) await cancelCriticalAlarm(medId);
        return;
      }

      const claims = loadCriticalNotificationClaims();
      if (scheduled) {
        // Persist the claim ONLY after the native schedule succeeded.
        setCriticalNotificationClaim(claims, medId, {
          claimed: true,
          alarmTime: chainCriticalDateMs,
        });
      } else {
        // Failed schedule → claim stays open so the foreground
        // fallback can still send one notification for this episode.
        setCriticalNotificationClaim(claims, medId, { claimed: false, alarmTime: null });
      }
      saveCriticalNotificationClaims(claims);
    };

    for (const med of medicationsRef.current) {
      const gen = nextGeneration(med.id);
      const { status } = calculateMedicationStatus(med);
      const isCriticalish = status === 'critical' || status === 'out_of_stock';
      const criticalDateMs = getCriticalAlarmDate(med, today);

      if (isCriticalish || criticalDateMs === null) {
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
          enqueueCriticalAlarmOp(medId, async () => {
            if (currentGeneration(medId) !== gen) return;
            await cancelCriticalAlarm(medId);
          });
        }
        continue;
      }

      // Sufficient with a future projected crossing at criticalDateMs.
      stillScheduled.add(med.id);

      const claim = getCriticalNotificationClaim(claimsNow, med.id);
      const medId = med.id;
      const medName = med.name;
      const unit = med.unit || 'قرص';

      if (claim?.claimed && claim.alarmTime === criticalDateMs) {
        // The claim says the alarm is armed exactly here. A claim is
        // business dedup state — it does NOT prove the native alarm
        // still exists (Android can drop previously-scheduled alarms:
        // SCHEDULE_EXACT_ALARM revoked, force-stop, OEM kills, the
        // notification otherwise removed). Verify before trusting:
        // verified → keep it (no re-arm, no duplicate); unverifiable or
        // missing → run the repair chain (cancel + re-schedule) whose
        // outcome writes the claim exactly like any fresh schedule.
        enqueueCriticalAlarmOp(medId, async () => {
          if (currentGeneration(medId) !== gen) return;
          const verified = await verifyCriticalAlarmPending(medId, criticalDateMs);
          if (verified || currentGeneration(medId) !== gen) return;
          await runScheduleChain(medId, medName, criticalDateMs, unit, gen);
        });
        continue;
      }

      enqueueCriticalAlarmOp(medId, () =>
        runScheduleChain(medId, medName, criticalDateMs, unit, gen)
      );
    }

    // Cancel alarms for meds that are no longer present (deleted).
    for (const prevId of scheduledCriticalIdsRef.current) {
      if (!stillScheduled.has(prevId)) {
        nextGeneration(prevId);
        enqueueCriticalAlarmOp(prevId, async () => {
          await cancelCriticalAlarm(prevId);
        });
      }
    }
    scheduledCriticalIdsRef.current = stillScheduled;
  }, [
    criticalSignature,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
    resumeTick,
  ]);
}
