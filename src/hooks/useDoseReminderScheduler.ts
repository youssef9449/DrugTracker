import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  cancelSnoozedDoseReminder,
  isDoseReminderTimeStillAhead,
} from '../utils/notifications';
import { clearSnoozedDoseForMed } from './useDoseReminders';

/**
 * Options for {@link useDoseReminderScheduler}.
 */
export interface UseDoseReminderSchedulerOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  /**
   * Whether exact-alarm permission is granted on Android 12+. When null,
   * the permission has not been checked yet (no scheduling). When false,
   * the scheduler does NOT schedule dose reminders (they would be inexact
   * and fire at unpredictable times — unacceptable for medication
   * reminders). When true, scheduling proceeds.
   *
   * On web / Android < 12 this is always true (no permission needed).
   */
  exactAlarmEnabled: boolean | null;
  /**
   * Bumped by App.tsx on every app resume (appStateChange) and on mount
   * it simply runs — drives the consumption-suppression reconciliation:
   * after a cold start or a resume, an already-consumed dose
   * (lastConsumedDate === today) can never produce TODAY's reminder,
   * even if a previous suppression attempt failed (bridge error, the
   * process being killed mid-operation). Mirrors the critical-alarm
   * scheduler's resumeTick pattern.
   */
  resumeTick?: number;
}

/**
 * Native recurring daily dose-reminder scheduler.
 *
 * For each medication with `reminderEnabled + reminderTime`, schedules a
 * RECURRING daily notification at the reminderTime via Android's
 * AlarmManager (or iOS's UNUserNotificationCenter). The reminder fires
 * EVERY DAY at the configured time — even when the app is killed, the
 * device is in Doze, or the user never opens the app. The user sees the
 * reminder in their notification drawer.
 *
 * The native notification uses a SEPARATE id band (doseAlarm = 6M) from
 * the immediate dose notification (dose = 3M) so the two never collide.
 * Both use the SAME channel (`dose-reminder-v2`) with the bundled native
 * sound. There is NO foreground/background channel switching.
 *
 * === Consumption suppression (today's dose already taken) ===
 * The recurring alarm is config-driven and knows NOTHING about
 * consumption: without extra handling it would fire at reminderTime even
 * on a day whose dose the user already took (lastConsumedDate === today
 * — set by BOTH the manual card action and the notification's take-dose
 * action, via consumeDose). Two cooperating mechanisms close that gap:
 *
 *   1. Consumption-aware scheduling (main effect): every schedule this
 *      hook makes bakes `skipToday: lastConsumedDate === today` into
 *      scheduleDoseReminder, so a (re)scheduled recurring alarm always
 *      starts from TOMORROW for a consumed day. This covers every
 *      reschedule trigger: cold start, reminder-config change, and
 *      notifications/exact-alarm re-enable. Without it, ANY later
 *      reschedule (e.g. a med rename) would resurrect today's reminder
 *      for a consumed dose.
 *
 *   2. Consumption-suppression effect (below): reacts to the
 *      consumed-day signature (i.e. a dose was consumed while the app is
 *      running), to cold start, and to every resume (resumeTick). For
 *      each reminder-enabled medication consumed TODAY it:
 *        - cancels any pending SNOOZED one-shot reminder and clears the
 *          persisted snooze marker — a snoozed reminder for a taken dose
 *          must never fire, whether or not today's reminder time has
 *          already passed;
 *        - while today's reminder time is still ahead: cancels the
 *          pending recurring alarm and re-arms the SAME recurring daily
 *          schedule starting TOMORROW (skipToday). The re-armed alarm is
 *          persisted by the plugin (and re-armed on BOOT_COMPLETED), so
 *          tomorrow's reminder works with the app completely closed;
 *        - after today's reminder time has passed: touches nothing else
 *          — a notification that already fired is never retracted and
 *          the dismiss/snooze handling of the fired reminder is
 *          untouched (the plugin re-armed tomorrow's occurrence itself).
 *
 *      The suppression is NOT foreground-only logic: the consumption
 *      itself always happens in-app (card or notification action), so
 *      the hook is alive at that moment and the native cancel/schedule
 *      calls persist. Restart + resume reconciliation repairs any
 *      attempt that failed.
 *
 * Race protection — stale-async guard + per-med serialization:
 *   Same pattern as useCriticalAlarmScheduler. All cancel/schedule ops
 *   for a given med are chained onto a per-med Promise so they run in
 *   order. A generation counter lets a stale async bail before
 *   scheduling. Both effects share the chain and the counter, so a
 *   consumption landing while a config reschedule is in flight (or vice
 *   versa) serializes cleanly and the newest consumption-aware op wins.
 *
 * Boot persistence: scheduled notifications are persisted by the
 * @capacitor/local-notifications plugin and re-armed on BOOT_COMPLETED.
 *
 * This hook knows NOTHING about:
 *   - sounds (native channel owns the sound)
 *   - currentPills / lastSyncDate (those are stock/auto-deduct concerns;
 *     stock changes without consumption do NOT reschedule anything)
 */
export function useDoseReminderScheduler({
  medications,
  notificationsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmEnabled,
  resumeTick,
}: UseDoseReminderSchedulerOptions): void {
  const scheduledDoseIdsRef = useRef<Set<string>>(new Set());
  const doseGenerationRef = useRef<Map<string, number>>(new Map());
  const doseChainRef = useRef<Map<string, Promise<void>>>(new Map());

  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // Stable signature capturing ONLY the fields that affect the scheduled
  // notification: id, enabled state, reminder time, dose amount, unit, name.
  // currentPills and lastSyncDate are deliberately excluded — they affect
  // stock alert / auto-deduction systems, NOT the dose reminder schedule.
  // A pure stock change (refill, balance edit) must NOT trigger
  // cancel+reschedule of the daily reminder.
  //
  // Consumption (lastConsumedDate) is deliberately NOT part of this
  // signature either — but for the OPPOSITE reason: a consumption must
  // not trigger the full cancel+reschedule of EVERY medication, only a
  // targeted suppression of the consumed med. That is the separate
  // consumption-suppression effect below (keyed on its own
  // consumed-day signature). This effect still READS lastConsumedDate
  // at schedule time (skipToday) so any reschedule it does make can
  // never resurrect today's reminder for a consumed dose.
  const doseSignature = useMemo(
    () =>
      medications
        .map((m) =>
          [
            m.id,
            m.reminderEnabled ? 1 : 0,
            m.reminderTime ?? '',
            m.name,
            m.dailyDose,
            m.unit ?? '',
          ].join('|')
        )
        .sort()
        .join('\n'),
    [medications]
  );

  const enqueue = (medId: string, op: () => Promise<void>): Promise<void> => {
    const prev = doseChainRef.current.get(medId) ?? Promise.resolve();
    const next = prev.then(op, op);
    doseChainRef.current.set(medId, next);
    next.catch(() => void 0);
    return next;
  };

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    // User disabled notifications OR exact-alarm permission is missing →
    // cancel all previously-scheduled dose reminders and clear the
    // tracker. Exact-alarm is MANDATORY for medication dose reminders.
    if (!notificationsEnabled || exactAlarmEnabled !== true) {
      scheduledDoseIdsRef.current.forEach((id) => {
        doseGenerationRef.current.set(
          id,
          (doseGenerationRef.current.get(id) ?? 0) + 1
        );
        enqueue(id, () => cancelDoseReminder(id).then(() => cancelSnoozedDoseReminder(id)));
      });
      scheduledDoseIdsRef.current.clear();
      return;
    }

    const stillScheduled = new Set<string>();

    for (const med of medicationsRef.current) {
      const gen = (doseGenerationRef.current.get(med.id) ?? 0) + 1;
      doseGenerationRef.current.set(med.id, gen);

      if (!med.reminderEnabled || !med.reminderTime) {
        if (scheduledDoseIdsRef.current.has(med.id)) {
          enqueue(med.id, () => cancelDoseReminder(med.id).then(() => cancelSnoozedDoseReminder(med.id)));
        }
        continue;
      }

      const unit = med.unit || 'قرص';
      const name = med.name;
      const reminderTime = med.reminderTime;
      const dailyDose = med.dailyDose;
      // Consumption-aware scheduling: when today's dose was already
      // consumed (manual card action or the notification's take-dose
      // action), the recurring alarm must (re)start from TOMORROW —
      // never today. Captured at effect-run time like the other
      // schedule inputs; the generation guard keeps a stale op
      // powerless if a newer run (or the suppression effect) supersedes
      // it before the async op executes.
      const consumedToday = med.lastConsumedDate === getTodayDateString();

      enqueue(med.id, () =>
        cancelDoseReminder(med.id)
          .then(() => {
            if (doseGenerationRef.current.get(med.id) !== gen) return;
            return (
              consumedToday
                ? scheduleDoseReminder(
                    med.id,
                    name,
                    reminderTime,
                    dailyDose,
                    unit,
                    { skipToday: true }
                  )
                : scheduleDoseReminder(
                    med.id,
                    name,
                    reminderTime,
                    dailyDose,
                    unit
                  )
            ).then(() => {
              if (doseGenerationRef.current.get(med.id) !== gen) {
                return cancelDoseReminder(med.id);
              }
            });
          })
      );
      stillScheduled.add(med.id);
    }

    for (const prevId of scheduledDoseIdsRef.current) {
      if (!stillScheduled.has(prevId)) {
        doseGenerationRef.current.set(
          prevId,
          (doseGenerationRef.current.get(prevId) ?? 0) + 1
        );
        enqueue(prevId, () => cancelDoseReminder(prevId).then(() => cancelSnoozedDoseReminder(prevId)));
      }
    }
    scheduledDoseIdsRef.current = stillScheduled;
  }, [
    doseSignature,
    notificationsEnabled,
    exactAlarmEnabled,
    hydrated,
    isFirstRun,
  ]);

  // ─────────────────────────────────────────────────────────────
  // Consumption-suppression effect — today's dose was taken, so today's
  // reminder must not fire. See the header doc (mechanism 2) for the
  // full design: snooze-cancel always; recurring cancel + skipToday
  // re-arm only while today's reminder time is still ahead; nothing
  // after it fired.
  //
  // Runs when the consumed-day signature changes (a dose was consumed,
  // or a day's consumption record changed), on cold start (mount), and
  // on every app resume (resumeTick) — the reconciliation points that
  // make the suppression survive process death and repair failures.
  // Declared AFTER the main scheduling effect so both mount effects
  // enqueue in a deterministic order on the shared per-med chain.
  // ─────────────────────────────────────────────────────────────
  const consumedSignature = useMemo(
    () =>
      medications
        .map((m) => `${m.id}|${m.lastConsumedDate ?? ''}`)
        .sort()
        .join('\n'),
    [medications]
  );

  // resumeTick is optional (tests/older callers omit it) — normalize it
  // once so the effect dependency list stays statically checkable.
  const resumeTickValue = resumeTick ?? 0;

  useEffect(() => {
    if (!hydrated || isFirstRun) return;
    if (!notificationsEnabled || exactAlarmEnabled !== true) return;

    const today = getTodayDateString();
    for (const med of medicationsRef.current) {
      if (!med.reminderEnabled || !med.reminderTime) continue;
      if (med.lastConsumedDate !== today) continue;

      const gen = (doseGenerationRef.current.get(med.id) ?? 0) + 1;
      doseGenerationRef.current.set(med.id, gen);

      const unit = med.unit || 'قرص';
      const name = med.name;
      const reminderTime = med.reminderTime;
      const dailyDose = med.dailyDose;

      enqueue(med.id, () =>
        // 1) A pending snoozed one-shot for a taken dose must never
        // fire — regardless of the reminder time (the user can snooze
        // long past reminderTime). Also clear the persisted snooze
        // marker so no stale snooze state survives the taken dose.
        cancelSnoozedDoseReminder(med.id)
          .then(() => {
            clearSnoozedDoseForMed(med.id);
            // 2) After today's reminder time, the recurring alarm has
            // already fired (or was already suppressed): never retract
            // a fired notification — tomorrow was re-armed by the
            // plugin itself when it fired. Only the snooze cleanup
            // above applies.
            if (!isDoseReminderTimeStillAhead(reminderTime)) return;
            // 3) Still ahead: cancel the pending recurring occurrence
            // for today and re-arm the SAME recurring daily schedule
            // starting TOMORROW. Persisted natively — survives the app
            // closing right after.
            return cancelDoseReminder(med.id).then(() => {
              if (doseGenerationRef.current.get(med.id) !== gen) return;
              return scheduleDoseReminder(
                med.id,
                name,
                reminderTime,
                dailyDose,
                unit,
                { skipToday: true }
              ).then(() => {
                if (doseGenerationRef.current.get(med.id) !== gen) {
                  return cancelDoseReminder(med.id);
                }
              });
            });
          })
      );
    }
  }, [
    consumedSignature,
    resumeTickValue,
    notificationsEnabled,
    exactAlarmEnabled,
    hydrated,
    isFirstRun,
  ]);
}
