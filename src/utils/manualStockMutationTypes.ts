import type { ConsumptionLog, Medication } from '../types';

export type GatedManualOutcome =
  | 'applied'
  | 'already_consumed'
  | 'already_restored'
  | 'missing_med'
  | 'missing_dose_id'
  | 'persist_failed'
  | 'rejected';
export interface GatedManualConsumeResult {
  outcome: GatedManualOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  doseAmount: number;
  log: ConsumptionLog | null;
  reason?: string;
  /**
   * Canonical dose identity actually consumed (present on success).
   * Downstream notification cancellation MUST use this value — never the
   * original optional caller argument (#515).
   */
  doseId?: string;
  /** Fresh durable medication name/unit for UI (never from React snapshot). */
  medicationName?: string;
  unit?: string;
}
export interface GatedManualRestoreResult {
  outcome: GatedManualOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  restoredAmount: number;
  log: ConsumptionLog | null;
  reason?: string;
  /** Fresh durable medication name for UI toasts (never from React snapshot). */
  medicationName?: string;
  /** Fresh durable unit for UI log descriptions. */
  unit?: string;
}
export interface GatedAddMedicationResult {
  outcome: 'applied' | 'duplicate_med_id' | 'persist_failed';
  medications: Medication[];
  logs: ConsumptionLog[];
  medicationName?: string;
  unit?: string;
  reason?: string;
}
export type GatedRefillOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'rejected';
export interface GatedRefillResult {
  outcome: GatedRefillOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  addedPills: number;
  log: ConsumptionLog | null;
  reason?: string;
  /** Fresh durable medication name for UI toasts (never from React snapshot). */
  medicationName?: string;
  unit?: string;
}
export type GatedToggleOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'native_list_failed'
  | 'native_invalidation_failed';
export interface GatedAutoDeductToggleResult {
  outcome: GatedToggleOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  newState: boolean;
  settleLog: ConsumptionLog | null;
  medicationName?: string;
  unit?: string;
  reason?: string;
}
export interface GatedGlobalAutoDeductToggleResult {
  outcome:
    | 'applied'
    | 'persist_failed'
    | 'native_list_failed'
    | 'native_invalidation_failed';
  medications: Medication[];
  logs: ConsumptionLog[];
  enable: boolean;
  settleLogs: ConsumptionLog[];
  reason?: string;
}
export type GatedDeleteMedicationOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'native_list_failed'
  | 'native_invalidation_failed';
export interface GatedDeleteMedicationResult {
  outcome: GatedDeleteMedicationOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  medicationName?: string;
  unit?: string;
  reason?: string;
}
export type GatedBackupRestoreOutcome =
  | 'applied'
  | 'empty_medications'
  | 'persist_failed'
  | 'native_list_failed';
export interface GatedBackupRestoreResult {
  outcome: GatedBackupRestoreOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  restoredCount: number;
  reason?: string;
}
export type GatedMedicationUpdateOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'native_list_failed'
  | 'native_invalidation_failed';
export interface GatedMedicationUpdateResult {
  outcome: GatedMedicationUpdateOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  settleLog: ConsumptionLog | null;
  medicationName?: string;
  unit?: string;
  reason?: string;
}