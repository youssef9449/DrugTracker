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
}

export function runGatedGlobalAutoDeductToggle(opts: {
  enable: boolean;
  todayStr?: string;
  now?: Date;
}
