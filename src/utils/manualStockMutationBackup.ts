import type { ConsumptionLog, Medication } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import type { GatedBackupRestoreResult } from './manualStockMutationTypes';
import {
  invalidateMedicationRecurrences,
  invalidateMedicationDoseReminders,
} from './manualStockMutationShared';

export function runGatedBackupRestore(opts: {
  backupMedications: Medication[];
  backupLogs?: ConsumptionLog[] | undefined;
  mode: 'replace' | 'merge';
}): Promise<GatedBackupRestoreResult> {
  return runManualStockTransaction({
    reconcileExactBeforeMutation: false,
    onFailure: (failure) => ({
      outcome: 'persist_failed' as const,
      medications: failure.state.medications,
      logs: failure.state.logs,
      restoredCount: 0,
      reason: failure.reason,
    }),
    operation: async ({ fresh }) => {
      if (opts.backupMedications.length === 0) {
        return {
          outcome: 'empty_medications' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          restoredCount: 0,
          reason: 'empty_medications',
        };
      }

      let nextMedications: Medication[];
      let nextLogs: ConsumptionLog[];
      const toInvalidate: Medication[] = [];

      if (opts.mode === 'replace') {
        // Invalidate old active native recurrences and dose reminders
        for (const m of fresh.medications) {
          toInvalidate.push(m);
        }
        nextMedications = opts.backupMedications;
        nextLogs = opts.backupLogs && opts.backupLogs.length > 0 ? opts.backupLogs : fresh.logs;
      } else {
        // Merge mode:
        const freshById = new Map(fresh.medications.map((m) => [m.id, m]));
        const freshByName = new Map(
          fresh.medications.map((m) => [m.name.trim().toLocaleLowerCase(), m])
        );

        const updatedMeds: Medication[] = [];
        const addedMeds: Medication[] = [];
        const touchedExistingIds = new Set<string>();

        for (const backupMed of opts.backupMedications) {
          const existing =
            freshById.get(backupMed.id) ||
            freshByName.get(backupMed.name.trim().toLocaleLowerCase());

          if (existing) {
            touchedExistingIds.add(existing.id);
            toInvalidate.push(existing);
            updatedMeds.push({
              ...backupMed,
              id: existing.id,
            });
          } else {
            addedMeds.push(backupMed);
          }
        }

        const untouched = fresh.medications.filter((m) => !touchedExistingIds.has(m.id));
        nextMedications = [...untouched, ...updatedMeds, ...addedMeds];

        if (opts.backupLogs && opts.backupLogs.length > 0) {
          const existingLogIds = new Set(fresh.logs.map((l) => l.id));
          const newLogs = opts.backupLogs.filter((l) => !existingLogIds.has(l.id));
          nextLogs = [...newLogs, ...fresh.logs];
        } else {
          nextLogs = fresh.logs;
        }
      }

      // Invalidate old alarms for any medications being replaced or updated
      for (const med of toInvalidate) {
        if (med.autoDeductEnabled) {
          try {
            await invalidateMedicationRecurrences(med);
          } catch {
            // best-effort invalidation
          }
        }
        if (med.reminderEnabled) {
          try {
            await invalidateMedicationDoseReminders(med);
          } catch {
            // best-effort invalidation
          }
        }
      }

      // Commit through manual envelope with native stock reconciliation
      const err = await commitWithManualEnvelope(
        {
          medications: nextMedications,
          logs: nextLogs,
          globalAutoDeductEnabled: fresh.globalAutoDeductEnabled,
        },
        fresh.medications
      );

      if (err) {
        return {
          outcome: 'persist_failed' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          restoredCount: 0,
          reason: err,
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
