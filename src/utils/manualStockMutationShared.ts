/**
 * Shared native invalidation/compensation coordinator for Manual Stock mutations.
 *
 * This module owns cross-feature native ordering barriers common to multiple
 * mutation families. The public facade remains manualStockMutation.ts.
 */
import type { Medication } from '../types';
import { recurrenceDefinition, recurrenceDoseIds } from './autoDeductionDefinition';
import {
  invalidateAutoDeductionRecurrence,
  scheduleAutoDeduction,
  recoverAutoDeductionOccurrenceForCompensation,
} from './autoDeductionNativeScheduling';
import {
  isDoseConsumedOnDate,
  getTodayDateString,
  tomorrowDateString,
  localEpochMs,
} from './dateCalculations';
import {
  getMedicationTreatmentEndDate,
  isMedicationTreatmentActiveOnDate,
} from './medicationTreatment';
import { cancelDoseReminderNative, cancelDoseSnoozeNative } from './doseReminderNative';
import { scheduleDoseReminder } from './doseReminderScheduling';
import { scheduleSnoozedDoseReminder } from './notifications/doseReminderNotifications';
import { getSnoozeUntil, isSnoozeActive } from './doseReminderStorage';
import { getDoseReminderSlots } from './doseReminderDefinitions';

export interface DoseReminderInvalidationResult {
  ok: boolean;
  error?: string;
}

export async function restoreInvalidatedRecurrences(
  med: Medication,
  invalidated: Array<{ doseId: string; generation: number }>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const today = getTodayDateString();
  const tomorrow = tomorrowDateString(today);
  if (!tomorrow) return { ok: false, error: 'invalid_next_date' };
  const treatmentEndDate = getMedicationTreatmentEndDate(med);
  for (const entry of invalidated) {
    const def = recurrenceDefinition(med, entry.doseId);
    if (!def) continue;
    for (const calendarDate of [today, tomorrow]) {
      if (!isMedicationTreatmentActiveOnDate(med, calendarDate)) continue;
      if (treatmentEndDate && calendarDate > treatmentEndDate) continue;
      const epoch = localEpochMs(calendarDate, def.time);
      if (epoch == null) return { ok: false, error: 'invalid_occurrence_datetime' };
      if (epoch <= Date.now() - 2000) {
        const generation = entry.generation ?? 0;
        if (generation <= 0) return { ok: false, error: 'missing_compensation_generation' };
        const recovery = await recoverAutoDeductionOccurrenceForCompensation(
          med.id, def.id, calendarDate, epoch, def.amount, generation,
          treatmentEndDate ?? undefined, def.time
        );
        if (!recovery.ok && recovery.error !== 'not_android') {
          return { ok: false, error: recovery.error ?? 'recovery_failed' };
        }
      } else {
        const result = await scheduleAutoDeduction({
          medicationId: med.id, doseId: def.id, calendarDate, timeHhmm: def.time,
          amount: def.amount, scheduledAtEpochMs: epoch,
          treatmentEndDate: treatmentEndDate ?? undefined,
        });
        if (!result.ok && result.error !== 'not_android') {
          return { ok: false, error: result.error ?? 'schedule_failed' };
        }
      }
    }
  }
  return { ok: true };
}

export async function invalidateMedicationDoseReminders(med: Medication): Promise<DoseReminderInvalidationResult> {
  try {
    for (const slot of getDoseReminderSlots(med)) {
      await cancelDoseReminderNative(med.id, slot.doseId);
      await cancelDoseSnoozeNative(med.id, slot.doseId);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'dose_reminder_invalidation_failed',
    };
  }
}

export async function restoreInvalidatedDoseReminders(med: Medication): Promise<DoseReminderInvalidationResult> {
  try {
    if (!med.reminderEnabled) return { ok: true };
    const today = getTodayDateString();
    if (!isMedicationTreatmentActiveOnDate(med, today)) return { ok: true };
    const treatmentEndDate = getMedicationTreatmentEndDate(med);
    const allowManualTakeAction = med.autoDeductEnabled === false;
    for (const slot of getDoseReminderSlots(med)) {
      const shouldSkipToday = isDoseConsumedOnDate(med, slot.doseId, today);
      await scheduleDoseReminder(
        med.id, med.name, slot.time, slot.amount, slot.unit, slot.doseId,
        {
          ...(shouldSkipToday ? { skipToday: true as const } : {}),
          allowManualTakeAction,
          ...(slot.description ? { doseDescription: slot.description } : {}),
          ...(treatmentEndDate ? { treatmentEndDate } : {}),
        }
      );
      const snoozeUntilOutcome = getSnoozeUntil(med.id, slot.doseId);
      const snoozeUntil =
        snoozeUntilOutcome.status === 'ok' ? snoozeUntilOutcome.value : null;
      if (
        snoozeUntil != null &&
        snoozeUntil > Date.now() &&
        isSnoozeActive(med.id, slot.doseId)
      ) {
        const remainingMinutes = Math.max(0.001, (snoozeUntil - Date.now()) / 60_000);
        await scheduleSnoozedDoseReminder(
          med.id, med.name, slot.amount, slot.unit, slot.time, remainingMinutes,
          slot.doseId, allowManualTakeAction, slot.description
        );
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'dose_reminder_restore_failed',
    };
  }
}

export interface RecurrenceInvalidationResult {
  ok: boolean;
  error?: string;
  invalidatedDoseIds: string[];
  invalidated: Array<{ doseId: string; generation: number }>;
}

export async function invalidateMedicationRecurrences(med: Medication): Promise<RecurrenceInvalidationResult> {
  const invalidatedDoseIds: string[] = [];
  const invalidated: Array<{ doseId: string; generation: number }> = [];
  for (const doseId of recurrenceDoseIds(med)) {
    const result = await invalidateAutoDeductionRecurrence(med.id, doseId);
    if (!result.ok && result.error !== 'not_android') {
      if (result.schedulesCancelled && (result.generation ?? 0) > 0) {
        invalidatedDoseIds.push(doseId);
        invalidated.push({ doseId, generation: result.generation ?? 0 });
      }
      let compensationError: string | undefined;
      if (invalidated.length > 0) {
        const compensation = await restoreInvalidatedRecurrences(med, invalidated);
        if (!compensation.ok) compensationError = compensation.error;
      }
      return {
        ok: false,
        error: compensationError
          ? `${result.error ?? 'native_invalidation_failed'};compensation:${compensationError}`
          : result.error ?? 'native_invalidation_failed',
        invalidatedDoseIds, invalidated,
      };
    }
    if (result.ok) {
      invalidatedDoseIds.push(doseId);
      invalidated.push({ doseId, generation: result.generation ?? 0 });
    }
  }
  return { ok: true, invalidatedDoseIds, invalidated };
}
