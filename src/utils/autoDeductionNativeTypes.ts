import type { NativeErrorCode } from './nativeErrors';

export interface AutoDeductionEvent {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  scheduledAtEpochMs: number;
  amount: number;
  status: 'FIRED' | 'RECONCILED' | 'REJECTED' | string;
  createdAtEpochMs: number;
  reconciledAtEpochMs: number | null;
  /** Native Auto stock execution result surfaced during JS repair/reconciliation. */
  nativeStockApplied?: boolean;
  actualDeducted?: number;
}
export interface NativeAutoStockMedication {
  medicationId: string;
  currentPills: number;
}
export interface NativeAutoOccurrenceResolution {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  type: 'CONSUMED' | 'SKIPPED';
}
export interface InitializeNativeStockResult {
  ok: boolean;
  stocks: NativeAutoStockMedication[];
  error?: string;
  errorCode?: NativeErrorCode;
}
export interface ApplyForegroundStockDeltasResult {
  ok: boolean;
  alreadyApplied: boolean;
  stocks: NativeAutoStockMedication[];
  error?: string;
  errorCode?: NativeErrorCode;
}
export interface ApplyAutoDeductionStockResult {
  ok: boolean;
  /** True only when the Native Android stock authority executed the operation. */
  native: boolean;
  applied: boolean;
  actualDeducted: number;
  currentPills: number;
  error?: string;
  errorCode?: NativeErrorCode;
}
export interface MarkReconciledResult {
  ok: boolean;
  changed: boolean;
  error?: string;
  errorCode?: NativeErrorCode;
}
export interface ExactAutoDeductionFiredEvent {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  scheduledAtEpochMs: number;
  amount: number;
}
export interface ScheduleOccurrenceParams {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  timeHhmm: string;
  amount: number;
  scheduledAtEpochMs?: number;
  treatmentEndDate?: string;
  /** Auto-owned retry evidence surfaced by the native schedule listing. */
  fireRetryCount?: number;
}
export interface ScheduleOccurrenceResult {
  ok: boolean;
  error?: string;
  errorCode?: NativeErrorCode;
  occurrenceKey?: string;
}
export type RecoverAutoOccurrenceStatus =
  | 'CANCELLED'
  | 'CREATED'
  | 'ALREADY_EXISTS'
  | 'FAILED';

export interface RecoverAutoOccurrenceResult {
  ok: boolean;
  status: RecoverAutoOccurrenceStatus;
  error?: string;
  errorCode?: NativeErrorCode;
}
export interface ScheduledOccurrence {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  timeHhmm?: string;
  amount?: number;
  scheduledAtEpochMs?: number;
  fireRetryCount?: number;
}
/**
 * Explicit result for native schedule listing.
 * Successful empty list: { ok: true, schedules: [] }
 * Native read failure:  { ok: false, schedules: [], error }
 * Never conflate the two — callers must check ok before treating schedules
 * as an authoritative native snapshot.
 */
export interface ListScheduledOccurrencesResult {
  ok: boolean;
  schedules: ScheduledOccurrence[];
  error?: string;
  errorCode?: NativeErrorCode;
}
export type CancelOccurrenceStatus = "SUCCESS" | "ALREADY_ABSENT" | "FAILED";
export interface CancelOccurrenceResult {
  ok: boolean;
  status: CancelOccurrenceStatus;
  error?: string;
  errorCode?: NativeErrorCode;
}
/**
 * Explicit result for native future-schedule restoration.
 * ok=false means recovery boundary incomplete — callers must not run
 * destructive desired-state cleanup based on an incomplete snapshot.
 */
export interface RestoreFutureSchedulesResult {
  ok: boolean;
  restored: number;
  failed?: number;
  error?: string;
  errorCode?: NativeErrorCode;
}
