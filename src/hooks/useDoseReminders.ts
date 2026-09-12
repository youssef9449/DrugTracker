import { useCallback, useEffect, useRef, useState } from 'react';
import { Medication } from '../types';
import { getTodayDateString, isDoseConsumedOnDate } from '../utils/dateCalculations';
import { stopAllSounds } from '../utils/sound';
import { loadJson, saveJson } from '../utils/storage';
import { DEFAULT_SNOOZE_MINUTES, MS_PER_MINUTE } from '../utils/time';
import { scheduleSnoozedDoseReminder } from '../utils/notifications';
import {
  SNOOZE_KEY,
  isSnoozeActive,
  setSnoozeUntil,
  snoozeStorageKey,
} from '../utils/doseReminderStorage';

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';

function firedKey(medId: string, dateStr: string, doseId?: string) {
  return doseId ? `${medId}:${doseId}:${dateStr}` : `${medId}:${dateStr}`;
}

interface UseDoseRemindersOptions {
  medications: Medication[];
}

/**
 * In-app dose-reminder alarm UI controller.
 *
 * Owns the DoseAlarmModal state (medication + optional doseId that
 * triggered the alarm) and exposes openAlarm / dismissAlarm /
 * snoozeAlarm / testAlarm.
 *
 * Phase 3A: openAlarm accepts an optional doseId from the native
 * notification extra so Take Dose consumes that exact slot.
 *
 * Phase 3B: snooze markers are dose-scoped for multi-dose meds
 * (`medId::doseId`). Legacy meds continue to use the med-only key.
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
    if (current && !isTestAlarmRef.current) {
      const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
      const today = getTodayDateString();
      fired[firedKey(current, today, doseId ?? undefined)] = true;
      if (!doseId) {
        fired[firedKey(current, today)] = true;
      }
      saveJson(FIRED_KEY, fired);

      // Clear only this slot's snooze (or med-level for legacy).
      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      const key = snoozeStorageKey(current, doseId);
      if (snooze[key] !== undefined) {
        delete snooze[key];
        saveJson(SNOOZE_KEY, snooze);
      }
    }
    stopAllSounds();
    alarmingIdRef.current = null;
    alarmingDoseIdRef.current = null;
    isTestAlarmRef.current = false;
    setAlarmingMedication(null);
    setAlarmingDoseId(null);
  }, []);

  const snoozeAlarm = useCallback((medication: Medication, minutes: number = DEFAULT_SNOOZE_MINUTES) => {
    const doseId = alarmingDoseIdRef.current ?? undefined;
    setSnoozeUntil(medication.id, Date.now() + minutes * MS_PER_MINUTE, doseId);

    // Prefer the specific slot's amount/time when snoozing a multi-dose alarm.
    let amount = medication.dailyDose;
    let time = medication.reminderTime;
    if (doseId && Array.isArray(medication.doseSchedule)) {
      const slot = medication.doseSchedule.find((d) => d.id === doseId);
      if (slot) {
        amount = Number(slot.amount) || amount;
        time = slot.time || time;
      }
    }

    scheduleSnoozedDoseReminder(
      medication.id,
      medication.name,
      amount,
      medication.unit || 'قرص',
      time,
      minutes,
      doseId
    ).catch(() => void 0);
    alarmingIdRef.current = null;
    alarmingDoseIdRef.current = null;
    isTestAlarmRef.current = false;
    setAlarmingMedication(null);
    setAlarmingDoseId(null);
  }, []);

  /**
   * Open the in-app alarm for a medication, optionally bound to a
   * specific dose slot from the native notification.
   */
  const openAlarm = useCallback((medId: string, doseId?: string) => {
    const med = medicationsRef.current.find((m) => m.id === medId);
    if (!med) return;

    const today = getTodayDateString();

    // Per-slot or whole-med consumption guard.
    if (doseId) {
      if (isDoseConsumedOnDate(med, doseId, today)) return;
    } else if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
      const allDone = med.doseSchedule.every((d) =>
        isDoseConsumedOnDate(med, d.id, today)
      );
      if (allDone) return;
    } else if (med.lastConsumedDate === today) {
      return;
    }

    // Dedup: already showing this med (+ same dose when known).
    if (alarmingIdRef.current === med.id) {
      if (!doseId || doseId === alarmingDoseIdRef.current) return;
    }

    const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
    if (fired[firedKey(med.id, today, doseId)]) return;

    // Dose-scoped snooze: only suppress this slot (legacy = med-only key).
    if (isSnoozeActive(med.id, doseId)) return;

    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    alarmingDoseIdRef.current = doseId ?? null;
    setAlarmingMedication(med);
    setAlarmingDoseId(doseId ?? null);
  }, []);

  const testAlarm = useCallback((med: Medication) => {
    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    alarmingDoseIdRef.current = null;
    setAlarmingMedication(med);
    setAlarmingDoseId(null);
    isTestAlarmRef.current = true;
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
