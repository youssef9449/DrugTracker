import { useEffect, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString, getCriticalAlarmDate } from '../utils/dateCalculations';
import { scheduleCriticalAlarm, cancelCriticalAlarm } from '../utils/notifications';

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
 * For each medication, computes the projected calendar date the med
 * will cross the critical threshold (getCriticalAlarmDate) and
 * schedules a SINGLE one-shot notification at that date via Android's
 * AlarmManager (Capacitor LocalNotifications). The alarm fires even if
 * the app is killed — the user sees the alert in their drawer at the
 * projected critical date without ever opening the app.
 *
 * Re-schedule triggers: this effect re-runs (and re-schedules every
 * med's alarm) whenever any field that affects the critical date
 * changes:
 *   - med.id (a med was added or deleted — must cancel old, schedule new)
 *   - med.currentPills (snapshot changed via refill/consume/restore)
 *   - med.dailyDose (changed via edit — settlement handled in save)
 *   - med.lastSyncDate (changed via refill/consume/settlement)
 *   - med.warningThresholdDays (drives the critical threshold)
 *   - med.autoDeductEnabled (pausing freezes the projected crossing)
 *
 * Gating:
 *   - Skip entirely before hydration (don't schedule for seed data).
 *   - Skip when criticalStockAlertsEnabled is false (user opted out).
 *   - Skip when notificationsEnabled is false (no permission to show).
 *
 * Race protection — stale-async guard:
 *   cancelCriticalAlarm() and scheduleCriticalAlarm() are async (they
 *   go through Capacitor's bridge). If the medication state changes
 *   rapidly, you could have an older effect's `.then()` callback fire
 *   AFTER a newer effect run has already bumped the medication state
 *   (or after the med was deleted) — which would re-create a stale
 *   alarm. This hook prevents that with a per-med generation counter
 *   (`alarmGenerationRef`):
 *     1. Each effect run bumps the generation for every med it touches.
 *     2. The `.then()` callback after cancel() captures the generation
 *        at effect-run time and checks it against the current value
 *        before calling schedule(). If a newer run bumped the value,
 *        the stale run bails out — no stale schedule call.
 *     3. Deleting a med bumps its generation, so any in-flight
 *        schedule from a prior run for that med bails out.
 *
 *   This serializes per-med: only the LATEST effect run's schedule
 *   call actually fires.
 *
 * Boot persistence — Android reboot:
 *   The @capacitor/local-notifications plugin persists scheduled
 *   notifications to SharedPreferences and re-arms them on
 *   BOOT_COMPLETED via its LocalNotificationRestoreReceiver. So our
 *   scheduled one-shot critical alarms survive device reboots without
 *   the user opening the app — no extra code or BootReceiver needed.
 *
 *   If for some reason the boot receiver doesn't fire (e.g. the app
 *   was force-stopped before the reboot), the user opening the app
 *   triggers this effect (re-arms all alarms) as a fallback.
 */
export function useCriticalAlarmScheduler({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseCriticalAlarmSchedulerOptions): void {
  // Track previously-scheduled med ids so we can cancel alarms for
  // deleted meds (the medications array no longer contains them).
  const scheduledCriticalIdsRef = useRef<Set<string>>(new Set());
  // Per-med generation counter for stale-async race protection.
  // Each effect run bumps the value for the med it touches; the
  // .then() callback captures the value at effect-run time and bails
  // if a newer run bumped it.
  const alarmGenerationRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    // User opted out of either flag → cancel all previously-scheduled
    // alarms and clear the tracker. Also bump generations so any
    // in-flight schedule from a prior effect run is stale.
    if (!notificationsEnabled || !criticalStockAlertsEnabled) {
      scheduledCriticalIdsRef.current.forEach((id) => {
        alarmGenerationRef.current.set(
          id,
          (alarmGenerationRef.current.get(id) ?? 0) + 1
        );
        cancelCriticalAlarm(id).catch(() => void 0);
      });
      scheduledCriticalIdsRef.current.clear();
      return;
    }

    const today = getTodayDateString();
    const stillScheduled = new Set<string>();

    for (const med of medications) {
      // Bump generation for this med — any in-flight cancel+schedule
      // from a previous effect run is now stale.
      const gen = (alarmGenerationRef.current.get(med.id) ?? 0) + 1;
      alarmGenerationRef.current.set(med.id, gen);

      const criticalDateMs = getCriticalAlarmDate(med, today);
      if (criticalDateMs === null) {
        // No future crossing (dailyDose=0, frozen+sufficient, or
        // already critical) — cancel any previously-scheduled alarm
        // for this med, but don't schedule a new one.
        if (scheduledCriticalIdsRef.current.has(med.id)) {
          cancelCriticalAlarm(med.id).catch(() => void 0);
        }
        continue;
      }

      // We're going to schedule. Capture the generation so the
      // .then() callback can bail if a newer run superseded this one.
      // cancel() is called first so any existing alarm with the same
      // stable id is removed; then schedule() re-arms with the new
      // date. The race guard ensures only the latest run's schedule
      // actually fires.
      cancelCriticalAlarm(med.id)
        .then(() => {
          // Stale-guard: if a newer effect run bumped the generation,
          // bail out — don't schedule a stale alarm. This also covers
          // the case where the med was deleted between this run's
          // cancel() and now (deletion bumps the generation too).
          if (alarmGenerationRef.current.get(med.id) !== gen) return;
          return scheduleCriticalAlarm(
            med.id,
            med.name,
            criticalDateMs,
            med.unit || 'قرص'
          );
        })
        .catch(() => void 0);
      stillScheduled.add(med.id);
    }

    // Cancel alarms for meds that are no longer in the list (deleted).
    // Bump their generation so any in-flight schedule from a previous
    // run bails.
    for (const prevId of scheduledCriticalIdsRef.current) {
      if (!stillScheduled.has(prevId)) {
        alarmGenerationRef.current.set(
          prevId,
          (alarmGenerationRef.current.get(prevId) ?? 0) + 1
        );
        cancelCriticalAlarm(prevId).catch(() => void 0);
      }
    }
    scheduledCriticalIdsRef.current = stillScheduled;
  }, [
    medications,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
  ]);
}
