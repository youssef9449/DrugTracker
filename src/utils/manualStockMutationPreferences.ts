import type { ConsumptionLog, Medication } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import type {
  GatedAutoDeductToggleResult,
  GatedGlobalAutoDeductToggleResult,
} from './manualStockMutationTypes';
import {
  invalidateMedicationRecurrences,
  invalidateMedicationDoseReminders,
  restoreInvalidatedRecurrences,
  restoreInvalidatedDoseReminders,
  type RecurrenceInvalidationResult,
} from './manualStockMutationShared';

export function runGatedAutoDeductToggle(opts: {
  medicationId: string;
  todayStr?: string;
  now?: Date;
  globalAutoDeductEnabled?: boolean;
}): Promise<GatedAutoDeductToggleResult> {
  return runManualStockTransaction({
      now: opts.now,
      onFailure: (failure) => ({
        outcome: failure.kind === 'reconciliation' ? 'native_list_failed' as const : 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        newState: false,
        settleLog: null,
        reason: failure.reason,
      }),
      operation: async ({ fresh }) => {
    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        newState: false,
        settleLog: null,
        reason: 'missing_med',
      };
    }
    // per-med Auto ON/OFF changes configuration only.
    const newState = med.autoDeductEnabled === false;
    const updatedMed: Medication = { ...med, autoDeductEnabled: newState };
    const settleLog: ConsumptionLog | null = null;
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const logs = fresh.logs;
    // Native recurrence invalidation is the cross-domain ordering barrier.
    const invalidation = await invalidateMedicationRecurrences(med);
    if (!invalidation.ok) {
      return {
        outcome: 'native_invalidation_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        newState,
        settleLog: null,
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
      return {
        outcome: 'native_invalidation_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        newState,
        settleLog: null,
        reason: compensationError
          ? doseInvalidation.error + ';compensation:' + compensationError
          : doseInvalidation.error ?? 'native_invalidation_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    const err = await commitWithManualEnvelope({ medications, logs }, fresh.medications);
    if (err) {
      // Native invalidation already linearized the old schedule chain. Restore
      // it when the JS commit fails so a failed mutation does not leave the
      // medication without its previously authorized exact schedule.
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
        compensationError = doseCompensation.error ?? 'dose_reminder_restore_failed';
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        newState,
        settleLog: null,
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
      logs,
      newState,
      settleLog,
      medicationName: updatedMed.name,
      unit: updatedMed.unit,
    };
  }
  });
}

export function runGatedGlobalAutoDeductToggle(opts: {
  enable: boolean;
  todayStr?: string;
  now?: Date;
}): Promise<GatedGlobalAutoDeductToggleResult> {
  return runManualStockTransaction({
      now: opts.now, globalAutoDeductEnabled: opts.enable,
      onFailure: (failure) => ({
        outcome: failure.kind === 'reconciliation' ? 'native_list_failed' as const : 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        enable: opts.enable,
        settleLogs: [],
        reason: failure.reason,
      }),
      operation: async ({ fresh }) => {
    // Global is a bulk state setter for ALL existing medications AND the
    // default for newly added ones. Flip autoDeductEnabled only — do not
    // settle stock, invent consumption logs, or mutate currentPills here.
    // Schedulers/reminders react to the resulting medication-level flags.
    // Any global Auto change also changes the neutral manual-Take capability
    // carried by Dose Reminder payloads. Both Auto and Dose Reminder native
    // state are invalidated before the durable bulk commit.
    const invalidatedMeds: Array<{
      med: Medication;
      doseIds: string[];
      invalidated: Array<{ doseId: string; generation: number }>;
    }> = [];
    const invalidatedDoseMeds: Medication[] = [];

    for (const med of fresh.medications) {
      if (med.autoDeductEnabled === opts.enable) continue;

      let autoInvalidation:
        | RecurrenceInvalidationResult
        | null = null;

      if (opts.enable === false) {
        const invalidation = await invalidateMedicationRecurrences(med);
        autoInvalidation = invalidation;
        if (!invalidation.ok) {
          let compensationError: string | null = null;

          for (const completed of invalidatedMeds) {
            if (completed.invalidated.length === 0) continue;
            const compensation = await restoreInvalidatedRecurrences(
              completed.med,
              completed.invalidated
            );
            if (!compensation.ok && compensationError == null) {
              compensationError = compensation.error ?? null;
            }
          }

          return {
            outcome: 'native_invalidation_failed' as const,
            medications: fresh.medications,
            logs: fresh.logs,
            enable: opts.enable,
            settleLogs: [],
            reason: compensationError
              ? invalidation.error + ';compensation:' + compensationError
              : invalidation.error ?? 'native_invalidation_failed',
          };
        }

        invalidatedMeds.push({
          med,
          doseIds: invalidation.invalidatedDoseIds,
          invalidated: invalidation.invalidated,
        });
      }

      const doseInvalidation = await invalidateMedicationDoseReminders(med);
      if (!doseInvalidation.ok) {
        let compensationError: string | null = null;

        if (
          opts.enable === false
          && autoInvalidation
          && autoInvalidation.invalidated.length > 0
        ) {
          const compensation = await restoreInvalidatedRecurrences(
            med,
            autoInvalidation.invalidated
          );
          if (!compensation.ok) {
            compensationError = compensation.error ?? null;
          }
        }

        for (const completed of invalidatedMeds) {
          if (completed.invalidated.length === 0) continue;
          const compensation = await restoreInvalidatedRecurrences(
            completed.med,
            completed.invalidated
          );
          if (!compensation.ok && compensationError == null) {
            compensationError = compensation.error ?? null;
          }
        }

        for (const completed of invalidatedDoseMeds) {
          const compensation = await restoreInvalidatedDoseReminders(
            completed
          );
          if (!compensation.ok && compensationError == null) {
            compensationError = compensation.error ?? null;
          }
        }

        // The current medication's Dose Reminder invalidation may have
        // partially completed before reporting failure. Compensate it too.
        const currentDoseCompensation =
          await restoreInvalidatedDoseReminders(med);
        if (!currentDoseCompensation.ok && compensationError == null) {
          if (currentDoseCompensation.error) compensationError = currentDoseCompensation.error;
        }

        return {
          outcome: 'native_invalidation_failed' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          enable: opts.enable,
          settleLogs: [],
          reason: compensationError
            ? doseInvalidation.error + ';compensation:' + compensationError
            : doseInvalidation.error ?? 'native_invalidation_failed',
        };
      }

      invalidatedDoseMeds.push(med);
    }
    const medications = fresh.medications.map((med) =>
      med.autoDeductEnabled === opts.enable
        ? med
        : { ...med, autoDeductEnabled: opts.enable }
    );
    const err = await commitWithManualEnvelope({
      medications,
      logs: fresh.logs,
      globalAutoDeductEnabled: opts.enable,
    }, fresh.medications);
    if (err) {
      let compensationError: string | null = null;
      for (const completed of invalidatedMeds) {
        if (completed.invalidated.length > 0) {
          const compensation = await restoreInvalidatedRecurrences(
            completed.med,
            completed.invalidated
          );
          if (!compensation.ok && compensationError == null) {
            compensationError = compensation.error ?? null;
          }
        }
      }
      for (const completed of invalidatedDoseMeds) {
        const compensation = await restoreInvalidatedDoseReminders(
          completed
        );
        if (!compensation.ok && compensationError == null) {
          compensationError = compensation.error ?? null;
        }
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        enable: opts.enable,
        settleLogs: [],
        reason: compensationError
          ? 'persist_failed;compensation:' + compensationError
          : 'persist_failed',
      };
    }
    return {
      outcome: 'applied' as const,
      medications,
      logs: fresh.logs,
      enable: opts.enable,
      settleLogs: [],
    };
  }
  });
}

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