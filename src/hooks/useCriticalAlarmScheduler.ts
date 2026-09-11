import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString, getCriticalAlarmDate, getCriticalTransitionKey } from '../utils/dateCalculations';
import { scheduleCriticalAlarm, cancelCriticalAlarm } from '../utils/notifications';
import { saveJson } from '../utils/storage';

const SCHEDULED_TRANSITIONS_KEY = 'android_med_tracker_scheduled_critical_v1';

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
 * Race protection — stale-async guard + per-med serialization:
 *   cancelCriticalAlarm() and scheduleCriticalAlarm() are async (they
 *   go through Capacitor's bridge). Both operate on the SAME stable
 *   native notification id (`criticalAlarmId(medId)`), so an older
 *   generation's compensating cancel would remove a newer generation's
 *   already-placed alarm if the two operations interleave freely.
 *
 *   Two layers of protection:
 *
 *   A) PER-MED SERIALIZATION (the core fix). All cancel/schedule
 *      operations for a given med are chained onto a per-med Promise
 *      (`alarmChainRef.get(medId)`). Each effect run APPENDS its
 *      cancel+schedule+compensating-cancel to this chain, so they run
 *      strictly in order — a newer generation's operations wait for
 *      the older generation's full chain (including its compensating
 *      cancel) to complete first. This guarantees an older
 *      generation's compensating cancel runs BEFORE the newer
 *      generation's schedule, so it can only remove the older
 *      generation's OWN stale alarm — never the newer one.
 *
 *   B) GENERATION COUNTER (defense-in-depth). Even with serialization,
 *      we keep the per-med generation counter (`alarmGenerationRef`):
 *        1. Each effect run bumps the generation for every med it touches.
 *        2. Pre-schedule check: if a newer run bumped the gen, skip
 *           the schedule call (no point placing an alarm that will
 *           just be superseded).
 *        3. Post-schedule check: after schedule() resolves, re-check
 *           the gen; if it changed during the await, run a
 *           compensating cancel to undo this stale schedule. Because
 *           of (A), this compensating cancel runs BEFORE any newer
 *           generation's schedule, so it can only remove this
 *           generation's OWN alarm.
 *        4. Deleting a med bumps its generation, so any in-flight
 *           schedule from a prior run for that med bails out (or is
 *           re-canceled per step 3 if it already completed).
 *
 *   The combination guarantees: only the LATEST generation's schedule
 *   survives, and an older generation's compensating cancel can NEVER
 *   remove a newer generation's alarm (because serialization orders
 *   the older compensating cancel BEFORE the newer schedule).
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
  // Per-med serialization chain. Each effect run APPENDS its
  // cancel+schedule+compensating-cancel to this Promise so they run
  // strictly in order. This guarantees an older generation's
  // compensating cancel runs BEFORE a newer generation's schedule,
  // so the older cancel can only remove the older generation's OWN
  // alarm — never the newer one. Without this, the older
  // compensating cancel (which uses the SAME stable notification id
  // as the newer schedule) could remove the newer alarm if it ran
  // AFTER the newer schedule completed.
  const alarmChainRef = useRef<Map<string, Promise<void>>>(new Map());

  // #91: keep the latest medications in a ref so the effect can read the
  // current array without depending on the array reference (which changes
  // on every App render — even unrelated state like typing in a search
  // field — causing 3N async bridge calls per render).
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // #91: stable signature capturing ONLY the fields that affect the
  // critical alarm date (per getCriticalAlarmDate + scheduleCriticalAlarm):
  //   id, currentPills, dailyDose, lastSyncDate, warningThresholdDays,
  //   autoDeductEnabled, name, unit.
  // warningThresholdDays IS the user-configured threshold (no derived
  // sub-threshold). The effect is gated on this string so the full
  // cancel+schedule chain only re-runs when a med's alarm-relevant
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

  /**
   * Append an async operation to the per-med chain and return the
   * new chain tail. The operation runs only after any previously-
   * chained operation for this med completes.
   */
  const enqueue = (medId: string, op: () => Promise<void>): Promise<void> => {
    const prev = alarmChainRef.current.get(medId) ?? Promise.resolve();
    const next = prev.then(op, op); // run op whether prev resolved or rejected
    alarmChainRef.current.set(medId, next);
    // Swallow rejection on the stored tail so it doesn't surface as
    // an unhandled rejection. The caller of enqueue() can still hang
    // .then/.catch off the returned `next` if they want to observe
    // the result.
    next.catch(() => void 0);
    return next;
  };

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    // User opted out of either flag → cancel all previously-scheduled
    // alarms and clear the tracker. Also bump generations so any
    // in-flight schedule from a prior effect run is stale. The cancels
    // are enqueued per-med so they serialize against any in-flight
    // operations from prior generations (e.g. an older generation's
    // schedule that hasn't placed its alarm yet — its compensating
    // cancel will run AFTER this opt-out cancel, but it'll be a
    // no-op because the alarm was already removed).
    if (!notificationsEnabled || !criticalStockAlertsEnabled) {
      scheduledCriticalIdsRef.current.forEach((id) => {
        alarmGenerationRef.current.set(
          id,
          (alarmGenerationRef.current.get(id) ?? 0) + 1
        );
        enqueue(id, () => cancelCriticalAlarm(id));
      });
      scheduledCriticalIdsRef.current.clear();
      return;
    }

    const today = getTodayDateString();
    const stillScheduled = new Set<string>();
    const scheduledTransitions: Record<string, string> = {};

    for (const med of medicationsRef.current) {
      const gen = (alarmGenerationRef.current.get(med.id) ?? 0) + 1;
      alarmGenerationRef.current.set(med.id, gen);

      const criticalDateMs = getCriticalAlarmDate(med, today);
      if (criticalDateMs === null) {
        if (scheduledCriticalIdsRef.current.has(med.id)) {
          enqueue(med.id, () => cancelCriticalAlarm(med.id));
        }
        continue;
      }

      // Compute the transition key so the scheduled notification carries
      // enough metadata for app-restart reconciliation.
      const transitionKey = getCriticalTransitionKey(med, today) || `${med.id}:fallback`;

      const unit = med.unit || 'قرص';
      const name = med.name;
      enqueue(med.id, () =>
        cancelCriticalAlarm(med.id)
          .then(() => {
            if (alarmGenerationRef.current.get(med.id) !== gen) return;
            return scheduleCriticalAlarm(
              med.id,
              name,
              criticalDateMs,
              unit,
              transitionKey
            ).then(() => {
              if (alarmGenerationRef.current.get(med.id) !== gen) {
                return cancelCriticalAlarm(med.id);
              }
            });
          })
      );
      stillScheduled.add(med.id);
      scheduledTransitions[med.id] = transitionKey;
    }

    // Persist scheduled transitions for app-restart reconciliation.
    saveJson(SCHEDULED_TRANSITIONS_KEY, scheduledTransitions);

    // Cancel alarms for meds that are no longer in the list (deleted).
    // Bump their generation so any in-flight schedule from a previous
    // run bails. Enqueued so they serialize against in-flight ops.
    for (const prevId of scheduledCriticalIdsRef.current) {
      if (!stillScheduled.has(prevId)) {
        alarmGenerationRef.current.set(
          prevId,
          (alarmGenerationRef.current.get(prevId) ?? 0) + 1
        );
        enqueue(prevId, () => cancelCriticalAlarm(prevId));
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
