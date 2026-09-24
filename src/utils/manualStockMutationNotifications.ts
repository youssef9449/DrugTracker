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
