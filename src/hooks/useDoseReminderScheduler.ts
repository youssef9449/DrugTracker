import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  cancelSnoozedDoseReminder,
} from '../utils/notifications';

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
 * Race protection — stale-async guard + per-med serialization:
 *   Same pattern as useCriticalAlarmScheduler. All cancel/schedule ops
 *   for a given med are chained onto a per-med Promise so they run in
 *   order. A generation counter lets a stale async bail before scheduling.
 *
 * Boot persistence: scheduled notifications are persisted by the
 * @capacitor/local-notifications plugin and re-armed on BOOT_COMPLETED.
 *
 * This hook knows NOTHING about:
 *   - sounds (native channel owns the sound)
 *   - foreground/background state
 *   - custom sounds
 *   - soundEnabled
 */
export function useDoseReminderScheduler({
  medications,
  notificationsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmEnabled,
}: UseDoseReminderSchedulerOptions): void {
  const scheduledDoseIdsRef = useRef<Set<string>>(new Set());
  const doseGenerationRef = useRef<Map<string, number>>(new Map());
  const doseChainRef = useRef<Map<string, Promise<void>>>(new Map());

  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // Stable signature capturing ONLY the fields that affect the dose
  // reminder schedule (id, reminderEnabled, reminderTime, name, dailyDose,
  // unit, currentPills, lastSyncDate). The effect is gated on this string
  // so the full cancel+schedule chain only re-runs when a med's reminder
  // config actually changes.
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
            m.currentPills,
            m.lastSyncDate ?? '',
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
      const pills = effectiveCurrentPills(med);

      enqueue(med.id, () =>
        cancelDoseReminder(med.id)
          .then(() => {
            if (doseGenerationRef.current.get(med.id) !== gen) return;
            return scheduleDoseReminder(
              med.id,
              name,
              reminderTime,
              dailyDose,
              unit,
              pills,
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
}
