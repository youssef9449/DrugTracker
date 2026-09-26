import type { ConsumptionLog, Medication } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import type { GatedBackupRestoreResult } from './manualStockMutationTypes';
import {
  invalidateMedicationRecurrences,
  invalidateMedicationDoseReminders,
  restoreInvalidatedRecurrences,
  restoreInvalidatedDoseReminders,
  type RecurrenceInvalidationResult,
} from './manualStockMutationShared';

const EMPTY_RECURRENCE_INVALIDATION: RecurrenceInvalidationResult = {
  ok: true,
  invalidatedDoseIds: [],
  invalidated: [],
};

function normalizeMedicationName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function runGatedBackupRestore(opts: {
  backupMedications: Medication[];
  backupLogs?: ConsumptionLog[] | undefined;
  restoreLogs: boolean;
  mode: 'replace' | 'merge';
}): Promise<GatedBackupRestoreResult> {
  return runManualStockTransaction({
    reconcileExactBeforeMutation: true,
    onFailure: (failure) => ({
      outcome: 'persist_failed' as const,
      medications: failure.state.medications,
      logs: failure.state.logs,
      restoredCount: 0,
      reason: failure.reason,
    }),
    operation: async ({ fresh }) => {
      let nextMedications = fresh.medications;
      let nextLogs = fresh.logs;
      const invalidatedStates: Array<{
        medication: Medication;
        recurrence: RecurrenceInvalidationResult;
        doseRemindersInvalidated: boolean;
      }> = [];
      const backupMedicationIdToTargetId = new Map<string, string>();

      if (
        opts.mode === 'replace' &&
        !opts.backupMedications.length &&
        opts.restoreLogs
      ) {
        return {
          outcome: 'persist_failed' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          restoredCount: 0,
          reason: 'restore_logs_require_medications',
        };
      }

      if (opts.mode === 'replace') {
        if (opts.backupMedications.length > 0) {
          nextMedications = opts.backupMedications;
          for (const backupMedication of opts.backupMedications) {
            backupMedicationIdToTargetId.set(
              backupMedication.id,
              backupMedication.id
            );
          }

          for (const medication of fresh.medications) {
            const error = await invalidateNativeDefinitions(
              medication,
              invalidatedStates
            );
            if (error) {
              const compensationError = await compensateInvalidatedStates(
                invalidatedStates
              );
              return {
                outcome: 'persist_failed' as const,
                medications: fresh.medications,
                logs: fresh.logs,
                restoredCount: 0,
                reason: compensationError
                  ? error + ';compensation:' + compensationError
                  : error,
              };
            }
          }
        }
      } else if (opts.backupMedications.length > 0) {
        const freshById = new Map(fresh.medications.map((m) => [m.id, m]));
        const freshByName = new Map(
          fresh.medications.map((m) => [normalizeMedicationName(m.name), m])
        );
        const updatedMedications: Medication[] = [];
        const addedMedications: Medication[] = [];
        const touchedExistingIds = new Set<string>();

        for (const backupMedication of opts.backupMedications) {
          const existing =
            freshById.get(backupMedication.id) ||
            freshByName.get(normalizeMedicationName(backupMedication.name));

          if (existing) {
            backupMedicationIdToTargetId.set(
              backupMedication.id,
              existing.id
            );
            touchedExistingIds.add(existing.id);
            updatedMedications.push({
              ...backupMedication,
              id: existing.id,
            });
            const error = await invalidateNativeDefinitions(
              existing,
              invalidatedStates
            );
            if (error) {
              const compensationError = await compensateInvalidatedStates(
                invalidatedStates
              );
              return {
                outcome: 'persist_failed' as const,
                medications: fresh.medications,
                logs: fresh.logs,
                restoredCount: 0,
                reason: compensationError
                  ? error + ';compensation:' + compensationError
                  : error,
              };
            }
          } else {
            backupMedicationIdToTargetId.set(
              backupMedication.id,
              backupMedication.id
            );
            addedMedications.push(backupMedication);
          }
        }

        const untouched = fresh.medications.filter(
          (medication) => !touchedExistingIds.has(medication.id)
        );
        nextMedications = [
          ...untouched,
          ...updatedMedications,
          ...addedMedications,
        ];
      }

      if (opts.restoreLogs) {
        const sourceLogs = opts.backupLogs ?? [];
        const targetById = new Map(
          nextMedications.map((medication) => [medication.id, medication])
        );
        const remappedLogs: ConsumptionLog[] = [];

        for (const log of sourceLogs) {
          const targetId =
            backupMedicationIdToTargetId.get(log.medicationId) ??
            (opts.mode === 'merge'
              ? nextMedications.find(
                  (medication) =>
                    normalizeMedicationName(medication.name) ===
                    normalizeMedicationName(log.medicationName)
                )?.id
              : undefined);

          if (!targetId || !targetById.has(targetId)) {
            const compensationError =
              await compensateInvalidatedStates(invalidatedStates);
            return {
              outcome: 'persist_failed' as const,
              medications: fresh.medications,
              logs: fresh.logs,
              restoredCount: 0,
              reason: compensationError
                ? 'restore_log_medication_missing;compensation:' +
                  compensationError
                : 'restore_log_medication_missing',
            };
          }

          const targetMedication = targetById.get(targetId);
          remappedLogs.push({
            ...log,
            medicationId: targetId,
            ...(targetMedication
              ? { medicationName: targetMedication.name }
              : {}),
          });
        }

        if (opts.mode === 'replace') {
          nextLogs = remappedLogs;
        } else {
          const existingLogIds = new Set(fresh.logs.map((log) => log.id));
          const newLogs = remappedLogs.filter(
            (log) => !existingLogIds.has(log.id)
          );
          nextLogs = [...newLogs, ...fresh.logs];
        }
      }

      const err = await commitWithManualEnvelope(
        {
          medications: nextMedications,
          logs: nextLogs,
          globalAutoDeductEnabled: fresh.globalAutoDeductEnabled,
        },
        fresh.medications
      );

      if (err) {
        const compensationError =
          await compensateInvalidatedStates(invalidatedStates);
        return {
          outcome: 'persist_failed' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          restoredCount: 0,
          reason: compensationError
            ? err + ';compensation:' + compensationError
            : err,
        };
      }

      return {
        outcome: 'applied' as const,
        medications: nextMedications,
        logs: nextLogs,
        restoredCount: opts.backupMedications.length,
      };
    },
  });
}

async function invalidateNativeDefinitions(
  medication: Medication,
  invalidatedStates: Array<{
    medication: Medication;
    recurrence: RecurrenceInvalidationResult;
    doseRemindersInvalidated: boolean;
  }>
): Promise<string | null> {
  let recurrence = EMPTY_RECURRENCE_INVALIDATION;
  if (medication.autoDeductEnabled) {
    recurrence = await invalidateMedicationRecurrences(medication);
    if (!recurrence.ok) {
      return recurrence.error ?? 'native_invalidation_failed';
    }
  }

  let doseRemindersInvalidated = false;
  if (medication.reminderEnabled) {
    const doseInvalidation = await invalidateMedicationDoseReminders(medication);
    if (!doseInvalidation.ok) {
      if (recurrence.invalidated.length > 0) {
        await restoreInvalidatedRecurrences(
          medication,
          recurrence.invalidated
        );
      }
      await restoreInvalidatedDoseReminders(medication);
      return doseInvalidation.error ?? 'native_invalidation_failed';
    }
    doseRemindersInvalidated = true;
  }

  invalidatedStates.push({
    medication,
    recurrence,
    doseRemindersInvalidated,
  });
  return null;
}

async function compensateInvalidatedStates(
  invalidatedStates: Array<{
    medication: Medication;
    recurrence: RecurrenceInvalidationResult;
    doseRemindersInvalidated: boolean;
  }>
): Promise<string | null> {
  let firstError: string | null = null;

  for (let i = invalidatedStates.length - 1; i >= 0; i -= 1) {
    const entry = invalidatedStates[i];
    if (!entry) continue;

    if (entry.doseRemindersInvalidated) {
      const doseCompensation = await restoreInvalidatedDoseReminders(
        entry.medication
      );
      if (!doseCompensation.ok && firstError == null) {
        firstError =
          doseCompensation.error ?? 'dose_reminder_restore_failed';
      }
    }

    if (entry.recurrence.invalidated.length > 0) {
      const recurrenceCompensation = await restoreInvalidatedRecurrences(
        entry.medication,
        entry.recurrence.invalidated
      );
      if (!recurrenceCompensation.ok && firstError == null) {
        firstError =
          recurrenceCompensation.error ?? 'recurrence_restore_failed';
      }
    }
  }

  return firstError;
}
