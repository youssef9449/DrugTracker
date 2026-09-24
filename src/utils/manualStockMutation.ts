/**
 * Manual Stock mutation public facade.
 *
 * Feature implementations live in focused mutation-family modules:
 * consume/restore, inventory, medication lifecycle, and preferences.
 * The shared transaction pipeline remains the single owner of cross-cutting
 * durability and ordering.
 */
export type * from './manualStockMutationTypes';

export type {
  ManualStockEnvelope,
} from './stockEnvelopeRecovery';

export {
  recoverManualEnvelopeInto,
  loadManualStockEnvelope,
  saveManualStockEnvelope,
  STORAGE_MANUAL_ENVELOPE_KEY,
} from './stockEnvelopeRecovery';

export {
  shouldDismissAlarmAfterManualTake,
  resolveConsumeDoseId,
} from './manualStockMutationConsumeRestore';

export {
  runGatedManualConsume,
  runGatedManualRestore,
} from './manualStockMutationConsumeRestore';

export {
  runGatedRefill,
  runGatedUndoRefill,
} from './manualStockMutationInventory';

export {
  runGatedAddMedication,
  runGatedDeleteMedication,
  runGatedMedicationUpdate,
} from './manualStockMutationMedication';

export {
  runGatedAutoDeductToggle,
  runGatedGlobalAutoDeductToggle,
} from './manualStockMutationPreferences';

export {
  runGatedMedicationNotificationToggle,
} from './manualStockMutationNotifications';
