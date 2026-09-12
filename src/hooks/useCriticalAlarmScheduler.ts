import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { calculateMedicationStatus } from '../types';
import { getTodayDateString, getCriticalAlarmDate } from '../utils/dateCalculations';
import { scheduleCriticalAlarm, cancelCriticalAlarm } from '../utils/notifications';
import {
  loadCriticalNotificationClaims,
  saveCriticalNotificationClaims,
  getCriticalNotificationClaim,
  setCriticalNotificationClaim,
  clearCriticalNotificationClaim,
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
 *     claim already { claimed: true, alarmTime: T } → nothing (the alarm
 *       is already armed exactly here).
 *     otherwise → cancel the previous alarm, schedule at T; on success
 *       persist { claimed: true, alarmTime: T } — ONLY after
 *       scheduleCriticalAlarm() resolves successfully; on failure persist
 *       { claimed: false, alarmTime: null } so the foreground fallback
 *       stays available. A failed schedule NEVER suppresses the fallback.
 *
 *   Med SUFFICIENT with no future crossing (frozen: auto-deduct off, or
 *   dailyDose <= 0):
 *     cancel any armed alarm and clear the claim — the episode (if any)
 *     is over and nothing will cross the threshold without user action.
 *
 *   Flags disabled (either notificationsEnabled or
 *   criticalStockAlertsEnabled false):
 *     cancel every possibly-armed critical alarm (this session's and any
 *     left over from a previous session, found via the claim map) and
 *     restore claims whose still-future alarm was cancelled before it
 *     could fire, so re-enabling later re-opens the opportunity.
 *
 *   Deleted medications: their alarms are cancelled (their claim entries
 *   are removed by the foreground hook).
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

    // ── Flags disabled: cancel everything and restore open ──
    // ── opportunities consumed only by cancelled future alarms ──
    if (!notificationsEnabled || !criticalStockAlertsEnabled) {
      const ids = new Set([
        ...scheduledCriticalIdsRef.current,
        ...Object.keys(loadCriticalNotificationClaims()),
      ]);
      for (const id of ids) {
        nextGeneration(id);
        enqueueCriticalAlarmOp(id, async () => {
          await cancelCriticalAlarm(id);
          // A claim backed by a still-future alarm that we just
          // cancelled before it could fire must be released, so
          // re-enabling notifications re-opens exactly one opportunity.
          // Consumed claims (foreground send: alarmTime null; alarm
          // whose window already passed) are kept — their opportunity
          // was genuinely used.
          const claims = loadCriticalNotificationClaims();
          const claim = getCriticalNotificationClaim(claims, id);
          if (claim?.claimed && claim.alarmTime !== null && claim.alarmTime > Date.now()) {
            clearCriticalNotificationClaim(claims, id);
            saveCriticalNotificationClaims(claims);
          }
        });
      }
      scheduledCriticalIdsRef.current.clear();
      return;
    }

    const today = getTodayDateString();
    const stillScheduled = new Set<string>();
    const claimsNow = loadCriticalNotificationClaims();

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
        const hadAlarm = scheduledCriticalIdsRef.current.has(med.id);
        const claim = getCriticalNotificationClaim(claimsNow, med.id);
        const needsCleanup = hadAlarm || (claim !== null && !isCriticalish);
        if (needsCleanup) {
          enqueueCriticalAlarmOp(med.id, async () => {
            if (currentGeneration(med.id) !== gen) return;
            await cancelCriticalAlarm(med.id);
            if (!isCriticalish) {
              // Frozen sufficient med: clear the ended/stale claim so the
              // next episode gets a fresh opportunity. Critical meds keep
              // their claim — it is what suppresses duplicates.
              const claims = loadCriticalNotificationClaims();
              if (claims[med.id] !== undefined) {
                clearCriticalNotificationClaim(claims, med.id);
                saveCriticalNotificationClaims(claims);
              }
            }
          });
        }
        continue;
      }

      // Sufficient with a future projected crossing at criticalDateMs.
      stillScheduled.add(med.id);

      const claim = getCriticalNotificationClaim(claimsNow, med.id);
      if (claim?.claimed && claim.alarmTime === criticalDateMs) {
        // The alarm is already armed exactly here (persisted after a
        // previous successful schedule). Nothing to do.
        continue;
      }

      const medId = med.id;
      const medName = med.name;
      const unit = med.unit || 'قرص';

      enqueueCriticalAlarmOp(medId, async () => {
        await cancelCriticalAlarm(medId);
        if (currentGeneration(medId) !== gen) return; // a newer run superseded this one

        let scheduled = false;
        try {
          scheduled = (await scheduleCriticalAlarm(medId, medName, criticalDateMs, unit)) === true;
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
        if (getCriticalAlarmDate(currentMed, getTodayDateString()) !== criticalDateMs) {
          // The projection moved — a newer run will arm the right alarm.
          if (scheduled) await cancelCriticalAlarm(medId);
          return;
        }

        const claims = loadCriticalNotificationClaims();
        if (scheduled) {
          // Persist the claim ONLY after the native schedule succeeded.
          setCriticalNotificationClaim(claims, medId, {
            claimed: true,
            alarmTime: criticalDateMs,
          });
        } else {
          // Failed schedule → claim stays open so the foreground
          // fallback can still send one notification for this episode.
          setCriticalNotificationClaim(claims, medId, { claimed: false, alarmTime: null });
        }
        saveCriticalNotificationClaims(claims);
      });
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
  ]);
}
