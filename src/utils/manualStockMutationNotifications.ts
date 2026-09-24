import type { ConsumptionLog, Medication } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import { invalidateMedicationDoseReminders, restoreInvalidatedDoseReminders } from './manualStockMutationShared';

export function runGatedMedicationNotificationToggle(opts: {
  medicationId: string;
  field: 'reminderEnabled' | 'criticalStockAlertsEnabled';
  now?: Date;
}): Promise<{
  outcome:
    | 'applied'
    | 'missing_med'
    | 'persist_failed'
    | 'native_list_failed'
    | 'native_invalidation_failed';
  medications: Medication[];
  logs: ConsumptionLog[];
  medicationName?: string;
  enabled?: boolean;
}> {
  return runManualStockTransaction({
      now: opts.now,
      onFailure: (failure) => ({
        outcome: failure.kind === 'reconciliation' ? 'native_list_failed' as const : 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
      }),
      operation: async ({ fresh }) => {
    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
      };
    }
    const currentEnabled =
      opts.field === 'criticalStockAlertsEnabled'
        ? med.criticalStockAlertsEnabled === true
        : med.reminderEnabled === true;
    const enabled = !currentEnabled;
    const updatedMed: Medication = {
      ...med,
      [opts.field]: enabled,
    };
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );

    const doseInvalidation =
      opts.field === 'reminderEnabled'
        ? await invalidateMedicationDoseReminders(med)
        : { ok: true as const };
    if (!doseInvalidation.ok) {
      return {
        outcome: 'native_invalidation_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        medicationName: med.name,
        reason: doseInvalidation.error ?? 'native_invalidation_failed',
      };
    }

    const err = await commitWithManualEnvelope(
      { medications, logs: fresh.logs },
      fresh.medications
    );
    if (err) {
      let compensationError: string | undefined;
      if (opts.field === 'reminderEnabled') {
        const compensation = await restoreInvalidatedDoseReminders(med);
        if (!compensation.ok && compensation.error) compensationError = compensation.error;
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        medicationName: med.name,
        reason: compensationError
          ? 'persist_failed;compensation:' + compensationError
          : 'persist_failed',
      };
    }
    return {
      outcome: 'applied' as const,
      medications,
      logs: fresh.logs,
      medicationName: med.name,
      enabled,
    };
  }
  });
}
export function runGatedMedicationUpdate(opts: {
  editId: string;
  medData: Omit<Medication, 'id' | 'createdAt'>;
  todayStr?: string;
  now?: Date;
  globalAutoDeductEnabled?: boolean;
}): Promise<GatedMedicationUpdateResult> {
  return runManualStockTransaction({
      todayStr: opts.todayStr, now: opts.now,
      onFailure: (failure) => ({
        outcome: failure.kind === 'reconciliation' ? 'native_list_failed' as const : 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        settleLog: null,
        reason: failure.reason,
      }),
      operation: async ({ fresh }) => {
    const freshMed = fresh.medications.find((m) => m.id === opts.editId);
    if (!freshMed) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        settleLog: null,
        reason: 'missing_med',
      };
    }
    let invalidation: RecurrenceInvalidationResult = {
      ok: true,
      invalidatedDoseIds: [],
      invalidated: [],
    };
    let doseInvalidation: DoseReminderInvalidationResult = { ok: true };
    const autoChanged = autoDeductionDefinitionChanged(freshMed, opts.medData);
    const doseChanged = doseReminderDefinitionChanged(
      freshMed,
      opts.medData
    );
    if (autoChanged) {
      // Invalidate the old Auto chain before committing its defining
      // medication configuration.
      invalidation = await invalidateMedicationRecurrences(freshMed);
      if (!invalidation.ok) {
        return {
          outcome: 'native_invalidation_failed' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          settleLog: null,
          reason: invalidation.error ?? 'native_invalidation_failed',
          medicationName: freshMed.name,
          unit: freshMed.unit,
        };
      }
    }
    if (doseChanged) {
      // Invalidate the old Dose Reminder chain before committing its defining
      // medication configuration. Native cancellation is the linearization
      // barrier that prevents an old alarm from firing against the new state.
      doseInvalidation =
        await invalidateMedicationDoseReminders(freshMed);
      if (!doseInvalidation.ok) {
        let compensationError: string | undefined;
        if (autoChanged && invalidation.invalidated.length > 0) {
          const compensation = await restoreInvalidatedRecurrences(
            freshMed,
            invalidation.invalidated
          );
          if (!compensation.ok && compensation.error) compensationError = compensation.error;
        }
        const doseCompensation =
          await restoreInvalidatedDoseReminders(freshMed);
        if (!doseCompensation.ok && compensationError == null) {
          compensationError = doseCompensation.error;
        }
        return {
          outcome: 'native_invalidation_failed' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          settleLog: null,
          reason: compensationError
            ? doseInvalidation.error + ';compensation:' + compensationError
            : doseInvalidation.error ?? 'native_invalidation_failed',
          medicationName: freshMed.name,
          unit: freshMed.unit,
        };
      }
    }
    // dose edit changes configuration only. No stock settlement,
    // by a dose edit.
    const stockBase = freshMed;
    const settleLog: ConsumptionLog | null = null;
    // Prune from durable/settled history + NEW schedule — never from React form history.
    // Authority: fresh durable state → settlement result → prune using final schedule.
    const forPrune: Omit<Medication, 'id' | 'createdAt'> = {
      ...opts.medData,
      // Override any form-snapshot history with durable/settled authority.
      doseConsumptionHistory: stockBase.doseConsumptionHistory,
      doseSkippedHistory: stockBase.doseSkippedHistory,
    };
    const pruned = pruneDoseConsumption(forPrune, stockBase);
    // Build final med: user-editable fields from medData/pruned; stock/history from
    // stockBase then pruned schedule.
    const finalMed: Medication = {
      ...freshMed,
      ...pruned,
      id: freshMed.id,
      createdAt: freshMed.createdAt,
      currentPills: stockBase.currentPills,
      lastConsumedDate: stockBase.lastConsumedDate,
      autoDeductEnabled:
        opts.medData.autoDeductEnabled !== undefined
          ? opts.medData.autoDeductEnabled
          : stockBase.autoDeductEnabled,
      isChronic: opts.medData.isChronic,
      durationDays:
        opts.medData.isChronic
          ? undefined
          : opts.medData.durationDays,
      // Explicitly take pruned history (not stockBase) so removed dose IDs stay gone.
      doseConsumptionHistory: pruned.doseConsumptionHistory,
      doseSkippedHistory:
        pruned.doseSkippedHistory ?? stockBase.doseSkippedHistory,
    };
    const medications = fresh.medications.map((m) =>
      m.id === opts.editId ? finalMed : m
    );
    const logs = settleLog ? [settleLog, ...fresh.logs] : fresh.logs;
    const err = await commitWithManualEnvelope({ medications, logs }, fresh.medications);
    if (err) {
      // Only configuration-changing edits invalidate native recurrences.
      // Restore the old chain when the new JS state could not be committed.
      let compensationError: string | null = null;
      if (autoChanged && invalidation.invalidated.length > 0) {
        const compensation = await restoreInvalidatedRecurrences(
          freshMed,
          invalidation.invalidated
        );
        if (!compensation.ok) {
          compensationError = compensation.error ?? null;
        }
      }
      if (doseChanged) {
        const doseCompensation =
          await restoreInvalidatedDoseReminders(freshMed);
        if (!doseCompensation.ok && compensationError == null) {
          compensationError = doseCompensation.error ?? null;
        }
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        settleLog: null,
        reason: compensationError
          ? 'persist_failed;compensation:' + compensationError
          : 'persist_failed',
        medicationName: freshMed.name,
        unit: freshMed.unit,
      };
    }
    return {
      outcome: 'applied' as const,
      medications,
      logs,
      settleLog,
      medicationName: finalMed.name,
      unit: finalMed.unit,
    };
  }
  });
}
