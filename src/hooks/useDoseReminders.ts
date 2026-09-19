import { useCallback, useEffect, useRef, useState } from 'react';
import { Medication } from '../types';
import { getTodayDateString, isDoseConsumedOnDate } from '../utils/dateCalculations';
import { stopAllSounds } from '../utils/sound';
import { loadJson, saveJson } from '../utils/storage';
import { DEFAULT_SNOOZE_MINUTES, MS_PER_MINUTE } from '../utils/time';
import { scheduleSnoozedDoseReminder } from '../utils/notifications';
import {
  isSnoozeActive,
  setSnoozeUntil,
  clearSnoozedDose,
} from '../utils/doseReminderStorage';

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';

/** Fired-dedup key: medicationId + doseId + calendarDate (Issue #268). */
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
}

/**
 * In-app dose-reminder alarm UI controller.
 *
 * Occurrence identity is always medicationId + doseId + calendarDate.
 * doseSchedule is the sole source of amount/time (Issue #268).
 */
export function useDoseReminders({
  medications,
}: UseDoseRemindersOptions) {
  const [alarmingMedication, setAlarmingMedication] = useState<Medication | null>(null);
  const [alarmingDoseId, setAlarmingDoseId] = useState<string | null>(null);
  const alarmingIdRef = useRef<string | null>(null);
  const alarmingDoseIdRef = useRef<string | null>(null);
  const isTestAlarmRef = useRef(false);

  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  const dismissAlarm = useCallback(() => {
    const current = alarmingIdRef.current;
    const doseId = alarmingDoseIdRef.current;
    if (current && doseId && !isTestAlarmRef.current) {
      const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
      const today = getTodayDateString();
      fired[firedKey(current, today, doseId)] = true;
      saveJson(FIRED_KEY, fired);
      clearSnoozedDose(current, doseId);
    }
    stopAllSounds();
    alarmingIdRef.current = null;
    alarmingDoseIdRef.current = null;
    isTestAlarmRef.current = false;
    setAlarmingMedication(null);
    setAlarmingDoseId(null);
  }, []);

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

    setSnoozeUntil(medication.id, Date.now() + minutes * MS_PER_MINUTE, doseId);

    scheduleSnoozedDoseReminder(
      medication.id,
      medication.name,
      amount,
      medication.unit || 'قرص',
      time,
      minutes,
      doseId,
      medication.autoDeductEnabled !== false
    ).catch(() => void 0);

    alarmingIdRef.current = null;
    alarmingDoseIdRef.current = null;
    isTestAlarmRef.current = false;
    setAlarmingMedication(null);
    setAlarmingDoseId(null);
  }, [alarmingMedication]);

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

    // Auto-deduction active: no interactive alarm UI for this occurrence.
    if (med.autoDeductEnabled !== false) return;

    const today = getTodayDateString();
    if (isDoseConsumedOnDate(med, id, today)) return;

    if (alarmingIdRef.current === med.id && alarmingDoseIdRef.current === id) {
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
  }, []);

  /**
   * Test alarm UI: prefers first explicit schedule row when present.
   * Without doseSchedule, no-op (Issue #268).
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
