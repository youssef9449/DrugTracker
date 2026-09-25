import type { ConsumptionLog, Medication } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import type {
  GatedAddMedicationResult,
  GatedDeleteMedicationResult,
  GatedMedicationUpdateResult,
} from './manualStockMutationTypes';
import { autoDeductionDefinitionChanged } from './autoDeductionDefinition';
import { doseReminderDefinitionChanged } from './doseReminderDefinitions';
import { pruneDoseConsumption } from './pruneDoseConsumption';
import {
  invalidateMedicationRecurrences,
  invalidateMedicationDoseReminders,
  restoreInvalidatedRecurrences,
  restoreInvalidatedDoseReminders,
  type RecurrenceInvalidationResult,
  type DoseReminderInvalidationResult,
} from './manualStockMutationShared';
import { loadDurableGlobalAutoDeductEnabled } from './autoDeductionStockGate';

export function runGatedAddMedication(opts: {
  medication: Medication;
  reconcileExactBeforeMutation?: boolean;
}): Promise<GatedAddMedicationResult> {
  return runManualStockTransaction({
      reconcileExactBeforeMutation: opts.reconcileExactBeforeMutation,
      onFailure: (failure) => ({
        outcome: 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        reason: failure.reason,
      }),
      operation: async ({ fresh }) => {    if (fresh.medications.some((m) => m.id === opts.medication.id)) {
      return {
        outcome: 'duplicate_med_id' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        medicationName: opts.medication.name,
        unit: opts.medication.unit,
        reason: 'duplicate_med_id',
      };
    }
    const durableGlobal =
      fresh.globalAutoDeductEnabled ??
      loadDurableGlobalAutoDeductEnabled();
    const medication: Medication = {
      ...opts.medication,
      // The durable global value is the default for new medications, but an
      // explicit per-med choice from the creation form is authoritative.
      autoDeductEnabled:
        opts.medication.autoDeductEnabled !== undefined
          ? opts.medication.autoDeductEnabled
          : durableGlobal,
    };
    const medications = [medication, ...fresh.medications];
    const logs = fresh.logs;
    const err = await commitWithManualEnvelope({
      medications,
      logs,
      globalAutoDeductEnabled: fresh.globalAutoDeductEnabled,
    }, fresh.medications);
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        reason: 'persist_failed',
        medicationName: medication.name,
        unit: medication.unit,
      };
    }
    return {
      outcome: 'applied' as const,
      medications,
      logs,
      medicationName: medication.name,
      unit: medication.unit,
    };
  }
  });
}

export function runGatedDeleteMedication(opts: {
  medicationId: string;
}): Promise<GatedDeleteMedicationResult> {
  return runManualStockTransaction({
      onFailure: (failure) => ({
        outcome: failure.kind === 'reconciliation' ? 'native_list_failed' as const : 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        reason: failure.reason,
      }),
      operation: async ({ fresh }) => {    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        reason: 'missing_med',
      };
    }
    // Invalidate the deleted medication's old native recurrence before the
    // deletion is committed. This closes the same cross-domain race as edit/
    // toggle: a queued old alarm cannot create a new FIRED occurrence after
    // the deletion has linearized.
    const invalidation = await invalidateMedicationRecurrences(med);
    if (!invalidation.ok) {
      return {
        outcome: 'native_invalidation_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        reason: invalidation.error ?? 'native_invalidation_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    const doseInvalidation = await invalidateMedicationDoseReminders(med);
    if (!doseInvalidation.ok) {
      let compensationError: string | undefined;
      if (invalidation.invalidated.length > 0) {
        const compensation = await restoreInvalidatedRecurrences(
          med,
          invalidation.invalidated
        );
        if (!compensation.ok && compensation.error) compensationError = compensation.error;
      }
      const doseCompensation = await restoreInvalidatedDoseReminders(med);
      if (!doseCompensation.ok && compensationError == null) {
        if (doseCompensation.error) compensationError = doseCompensation.error;
      }
      return {
        outcome: 'native_invalidation_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        reason: compensationError
          ? doseInvalidation.error + ';compensation:' + compensationError
          : doseInvalidation.error ?? 'native_invalidation_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    const medications = fresh.medications.filter((m) => m.id !== opts.medicationId);
    const err = await commitWithManualEnvelope({
      medications,
      logs: fresh.logs,
    }, fresh.medications);
    if (err) {
      let compensationError: string | null = null;
      if (invalidation.invalidated.length > 0) {
        const compensation = await restoreInvalidatedRecurrences(
          med,
          invalidation.invalidated
        );
        if (!compensation.ok) {
          compensationError = compensation.error ?? null;
        }
      }
      const doseCompensation = await restoreInvalidatedDoseReminders(med);
      if (!doseCompensation.ok && compensationError == null) {
        if (doseCompensation.error) compensationError = doseCompensation.error;
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        reason: compensationError
          ? 'persist_failed;compensation:' + compensationError
          : 'persist_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    return {
      outcome: 'applied' as const,
      medications,
      logs: fresh.logs,
      medicationName: med.name,
      unit: med.unit,
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
  reconcileExactBeforeMutation?: boolean;
}): Promise<GatedMedicationUpdateResult> {
  return runManualStockTransaction({
      todayStr: opts.todayStr, now: opts.now,
      reconcileExactBeforeMutation: opts.reconcileExactBeforeMutation,
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