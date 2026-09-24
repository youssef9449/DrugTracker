import type { ConsumptionLog, Medication } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import { invalidateMedicationDoseReminders, restoreInvalidatedDoseReminders } from './manualStockMutationShared';

export function runGatedMedicationNotificationToggle(opts: {
  medicationId: string;
  field: 'reminderEnabled' | 'criticalStockAlertsEnabled';
  now?: Date;
}
