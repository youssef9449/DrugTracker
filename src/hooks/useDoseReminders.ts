import { useCallback, useEffect, useRef, useState } from 'react';
import { Medication } from '../types';
import { getTodayDateString, isDoseConsumedOnDate } from '../utils/dateCalculations';
import { stopAllSounds } from '../utils/sound';
import { loadJson, saveJson } from '../utils/storage';
import { DEFAULT_SNOOZE_MINUTES, MS_PER_MINUTE } from '../utils/time';
import { scheduleSnoozedDoseReminder } from '../utils/notifications/doseReminderNotifications';
import {
  bumpDoseReminderSnoozeGeneration,
  isCurrentDoseReminderSnoozeGeneration,
  enqueueDoseReminderSnoozeOpGuarded,
  doseReminderSnoozeKey,
} from '../utils/doseReminderOperations';
import {
  isSnoozeActive,
  setSnoozeUntil,
  clearSnoozedDose,
} from '../utils/doseReminderStorage';
const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';
/** Fired-dedup key: medicationId + doseId + calendarDate. */
function firedKey(medId: string, dateStr: string, doseId: string) {
  return `${medId}:${doseId}:${dateStr}`;
}
function findDoseRow(med: Medication, doseId: string) {
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return null;
  }
  const id = doseId.trim();
  if (!id) return null;
  const row = med.doseSchedule.find((d) => d && d.id === id);
  if (!row) return null;
  if (!(Number(row.amount) > 0)) return null;
  return row;
}
interface UseDoseRemindersOptions {
  medications: Medication[];
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
}
/**
 * In-app dose-reminder alarm UI controller.
 *
 * Occurrence identity is always medicationId + doseId + calendarDate.
 * doseSchedule is the sole source of amount/time.
 */
export function useDoseReminders({
  medications,
  allowManualTakeActionByMedicationId,
}: UseDoseRemindersOptions) {
  const [alarmingMedication, setAlarmingMedication] = useState<Medication | null>(null);
  const [alarmingDoseId, setAlarmingDoseId] = useState<string | null>(null);
  const alarmingIdRef = useRef<string | null>(null);
  const alarmingDoseIdRef = useRef<string | null>(null);
  const isTestAlarmRef = useRef(false);
  const queuedAlarmRef = useRef<Array<{ medicationId: string; doseId: string }>>([]);
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);
  const dequeueNextValidAlarm = useCallback((): { medicationId: string; doseId: string } | null => {
    const today = getTodayDateString();
    const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
    while (queuedAlarmRef.current.length > 0) {
      const next = queuedAlarmRef.current.shift()!;
      const med = medicationsRef.current.find((m) => m.id === next.medicationId);
      if (!med || !findDoseRow(med, next.doseId)) continue;
      if (isDoseConsumedOnDate(med, next.doseId, today)) continue;
      if (fired[firedKey(next.medicationId, today, next.doseId)]) continue;
      if (isSnoozeActive(next.medicationId, next.doseId)) continue;
      if (allowManualTakeActionByMedicationId.get(next.medicationId) === false) continue;
      return next;
    }
    return null;
  }, [allowManualTakeActionByMedicationId]);

  const dismissAlarm = useCallback((): boolean => {
    const current = alarmingIdRef.current;
    const doseId = alarmingDoseIdRef.current;
    if (current && doseId && !isTestAlarmRef.current) {
      const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
      const today = getTodayDateString();
      fired[firedKey(current, today, doseId)] = true;
      const persisted = saveJson(FIRED_KEY, fired);
      if (persisted !== null) return false;

      // Dismissal supersedes any in-flight snooze scheduling for this exact
      // dose. The shared generation prevents that request from publishing a
      // durable snooze marker after dismissal; the native cancel removes a
      // realization that may already have reached the platform.
      const operationKey = doseReminderSnoozeKey(current, doseId);
      const generation =
        bumpDoseReminderSnoozeGeneration(operationKey);
      void enqueueDoseReminderSnoozeOpGuarded(
        operationKey,
        generation,
        async () => {
          await cancelSnoozedDoseReminder(current, doseId);
          if (!clearSnoozedDose(current, doseId)) throw new Error('snooze_clear_persistence_failed');
        }
      );

    }
    stopAllSounds();
    const next = dequeueNextValidAlarm();
    if (next) {
      const nextMed = medicationsRef.current.find((m) => m.id === next.medicationId)!;
      alarmingIdRef.current = next.medicationId;
      alarmingDoseIdRef.current = next.doseId;
      isTestAlarmRef.current = false;
      setAlarmingMedication(nextMed);
      setAlarmingDoseId(next.doseId);
    } else {
      alarmingIdRef.current = null;
      alarmingDoseIdRef.current = null;
      isTestAlarmRef.current = false;
      setAlarmingMedication(null);
      setAlarmingDoseId(null);
    }
    return true;
  }, [dequeueNextValidAlarm]);
  const snoozeAlarm = useCallback((minutes: number = DEFAULT_SNOOZE_MINUTES) => {
    const medication = alarmingMedication;
    const doseId = alarmingDoseIdRef.current;
    if (!medication || !doseId) {
      alarmingIdRef.current = null;
      alarmingDoseIdRef.current = null;
      isTestAlarmRef.current = false;
      setAlarmingMedication(null);
      setAlarmingDoseId(null);
      return;
    }
    const row = findDoseRow(medication, doseId);
    if (!row) {
      alarmingIdRef.current = null;
      alarmingDoseIdRef.current = null;
      isTestAlarmRef.current = false;
      setAlarmingMedication(null);
      setAlarmingDoseId(null);
      return;
    }
    const amount = Number(row.amount);
    const time = row.time;
    const description = typeof row.description === 'string' && row.description.trim()
      ? row.description.trim()
      : undefined;
    const snoozeUntil = Date.now() + minutes * MS_PER_MINUTE;
    const operationKey = doseReminderSnoozeKey(
      medication.id,
      doseId
    );
    const generation = bumpDoseReminderSnoozeGeneration(operationKey);

    void enqueueDoseReminderSnoozeOpGuarded(
      operationKey,
      generation,
      async () => {
        // The durable JS marker follows the native scheduling result. A
        // failed schedule therefore cannot leave a phantom snooze.
        await scheduleSnoozedDoseReminder(
          medication.id,
          medication.name,
          amount,
          medication.unit || 'قرص',
          time,
          minutes,
          doseId,
          allowManualTakeActionByMedicationId.get(medication.id) ?? true,
          description
        );

        if (
          !isCurrentDoseReminderSnoozeGeneration(
            operationKey,
            generation
          )
        ) {
          // A Take/dismiss/disable action superseded this request while the
          // native schedule was in flight. Remove the stale realization.
          await cancelSnoozedDoseReminder(
            medication.id,
            doseId
          );
          return;
        }

        const persisted = setSnoozeUntil(medication.id, snoozeUntil, doseId);
        if (!persisted) {
          await cancelSnoozedDoseReminder(medication.id, doseId);
          throw new Error('snooze_persistence_failed');
        }
        const next = dequeueNextValidAlarm();
        if (next) {
          const nextMed = medicationsRef.current.find((m) => m.id === next.medicationId)!;
          alarmingIdRef.current = next.medicationId;
          alarmingDoseIdRef.current = next.doseId;
          isTestAlarmRef.current = false;
          setAlarmingMedication(nextMed);
          setAlarmingDoseId(next.doseId);
        } else {
          alarmingIdRef.current = null;
          alarmingDoseIdRef.current = null;
          isTestAlarmRef.current = false;
          setAlarmingMedication(null);
          setAlarmingDoseId(null);
        }
      }
    ).catch(() => {
      // Keep the alarm UI open so a transient native failure can be retried.
      // No snooze marker is persisted on failure.
    });
  }, [alarmingMedication, allowManualTakeActionByMedicationId, dequeueNextValidAlarm]);
  /**
   * Open the in-app alarm for an explicit doseSchedule occurrence.
   * Requires non-empty doseId present on med.doseSchedule.
   */
  const openAlarm = useCallback((medId: string, doseId: string) => {
    const id = typeof doseId === 'string' ? doseId.trim() : '';
    if (!id) return;
    const med = medicationsRef.current.find((m) => m.id === medId);
    if (!med) return;
    const row = findDoseRow(med, id);
    if (!row) return;
    // The business layer decides whether the manual Take action is allowed.
    if (allowManualTakeActionByMedicationId.get(med.id) === false) return;
    const today = getTodayDateString();
    if (isDoseConsumedOnDate(med, id, today)) return;
    if (alarmingIdRef.current === med.id && alarmingDoseIdRef.current === id) {
      return;
    }
    if (alarmingIdRef.current) {
      const alreadyQueued = queuedAlarmRef.current.some(
        (queued) => queued.medicationId === med.id && queued.doseId === id
      );
      if (!alreadyQueued) {
        queuedAlarmRef.current.push({ medicationId: med.id, doseId: id });
      }
      return;
    }
    const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
    if (fired[firedKey(med.id, today, id)]) return;
    if (isSnoozeActive(med.id, id)) return;
    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    alarmingDoseIdRef.current = id;
    setAlarmingMedication(med);
    setAlarmingDoseId(id);
  }, [allowManualTakeActionByMedicationId]);
  /**
   * Test alarm UI: prefers first explicit schedule row when present.
   * Without doseSchedule, no-op.
   */
  const testAlarm = useCallback((med: Medication) => {
    const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
    const first = schedule.find(
      (d) => d && typeof d.id === 'string' && d.id.trim() && Number(d.amount) > 0
    );
    if (!first) return;
    const id = first.id.trim();
    isTestAlarmRef.current = true;
    alarmingIdRef.current = med.id;
    alarmingDoseIdRef.current = id;
    setAlarmingMedication(med);
    setAlarmingDoseId(id);
  }, []);
  return {
    alarmingMedication,
    alarmingDoseId,
    openAlarm,
    dismissAlarm,
    snoozeAlarm,
    testAlarm,
  };
}