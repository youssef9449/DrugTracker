import type { ConsumptionLog, Medication } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import type { GatedAutoDeductToggleResult, GatedGlobalAutoDeductToggleResult } from './manualStockMutationTypes';
import {
  invalidateMedicationRecurrences,
  restoreInvalidatedRecurrences,
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
    now: opts.now,
    globalAutoDeductEnabled: opts.enable,
    onFailure: (failure) => ({
      outcome: failure.kind === 'reconciliation'
        ? 'native_list_failed' as const
        : 'persist_failed' as const,
      medications: failure.state.medications,
      logs: failure.state.logs,
      enable: opts.enable,
      settleLogs: [],
      reason: failure.reason,
    }),
    operation: async ({ fresh }) => {
      // Global Auto is a runtime kill switch. It must NEVER rewrite
      // medication.autoDeductEnabled; that flag remains the user's per-med
      // configuration and is restored automatically when the global switch
      // is enabled again.
      //
      // Disabling the switch invalidates currently authorized Exact Auto
      // recurrences for medications that are individually enabled, then
      // commits ONLY the global switch. Dose reminders are intentionally
      // untouched because they are an independent feature.
      const invalidatedMeds: Array<{
        med: Medication;
        invalidated: Array<{ doseId: string; generation: number }>;
      }> = [];

      const compensate = async (): Promise<string | null> => {
        for (const completed of invalidatedMeds) {
          if (completed.invalidated.length === 0) continue;
          const compensation = await restoreInvalidatedRecurrences(
            completed.med,
            completed.invalidated
          );
          if (!compensation.ok) {
            return compensation.error ?? 'recurrence_restore_failed';
          }
        }
        return null;
      };

      if (!opts.enable) {
        for (const med of fresh.medications) {
          // A medication that is already individually OFF has no Auto
          // recurrence authorization to invalidate here.
          if (med.autoDeductEnabled === false) continue;

          const invalidation = await invalidateMedicationRecurrences(med);
          if (!invalidation.ok) {
            const compensationError = await compensate();
            return {
              outcome: 'native_invalidation_failed' as const,
              medications: fresh.medications,
              logs: fresh.logs,
              enable: opts.enable,
              settleLogs: [],
              reason: compensationError
                ? (invalidation.error ?? 'native_invalidation_failed') +
                  ';compensation:' + compensationError
                : invalidation.error ?? 'native_invalidation_failed',
            };
          }

          invalidatedMeds.push({
            med,
            invalidated: invalidation.invalidated,
          });
        }
      }

      // Commit the global master switch only. The medication array is passed
      // through unchanged so the per-med Auto preferences survive OFF → ON.
      const err = await commitWithManualEnvelope(
        {
          medications: fresh.medications,
          logs: fresh.logs,
          globalAutoDeductEnabled: opts.enable,
        },
        fresh.medications
      );

      if (err) {
        const compensationError = await compensate();
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
        medications: fresh.medications,
        logs: fresh.logs,
        enable: opts.enable,
        settleLogs: [],
      };
    },
  });
}
