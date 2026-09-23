import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  AutoDeductionEvent,
  ApplyAutoDeductionStockResult,
  ApplyForegroundStockDeltasResult,
  InitializeNativeStockResult,
  MarkReconciledResult,
  RestoreFutureSchedulesResult,
  ScheduleOccurrenceParams,
  ScheduleOccurrenceResult,
  CancelOccurrenceResult,
  RecoverAutoOccurrenceResult,
  ScheduledOccurrence,
  ExactAutoDeductionFiredEvent,
  NativeAutoStockMedication,
  NativeAutoOccurrenceResolution,
} from './autoDeductionNativeTypes';

interface AutoDeductionPlugin {
  addListener(
    eventName: 'exactAutoDeductionFired',
    listenerFunc: (event: ExactAutoDeductionFiredEvent) => void
  ): Promise<PluginListenerHandle>;
  scheduleOccurrence(options: ScheduleOccurrenceParams): Promise<ScheduleOccurrenceResult>;
  cancelOccurrence(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }): Promise<CancelOccurrenceResult>;
  recoverMissedOccurrence(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
    scheduledAtEpochMs: number;
    amount: number;
    expectedRecurrenceGeneration: number;
  }): Promise<RecoverAutoOccurrenceResult>;
  recoverMissedOccurrenceForCompensation(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
    scheduledAtEpochMs: number;
    amount: number;
    expectedRecurrenceGeneration: number;
    treatmentEndDate?: string;
    timeHhmm: string;
  }): Promise<RecoverAutoOccurrenceResult>;
  /** bump recurrence generation + cancel all futures for dose slot. */
  invalidateRecurrenceAuthorization(options: {
    medicationId: string;
    doseId: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    generation?: number;
    schedulesCancelled?: boolean;
  }>;
  listFiredEvents(): Promise<{ ok: boolean; events: AutoDeductionEvent[]; error?: string }>;
  getOccurrenceSnapshot(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }): Promise<{
    ok: boolean;
    status?: string;
    amount?: number;
    error?: string;
  }>;
  markReconciled(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }): Promise<MarkReconciledResult>;
  restoreFutureSchedules(): Promise<RestoreFutureSchedulesResult>;
  listScheduledOccurrences(): Promise<{ schedules: ScheduledOccurrence[] }>;
  initializeStock(options: {
    medications: NativeAutoStockMedication[];
    occurrenceResolutions?: NativeAutoOccurrenceResolution[];
  }): Promise<InitializeNativeStockResult>;
  applyForegroundStockDeltas(options: {
    mutationSeq: number;
    deltas: Array<{ medicationId: string; delta: number }>;
    occurrenceResolutions?: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
      type: 'CONSUMED' | 'SKIPPED';
    }>;
  }): Promise<ApplyForegroundStockDeltasResult>;
  applyAutoDeductionStock(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
    amount: number;
  }): Promise<ApplyAutoDeductionStockResult>;
  recoverAutoDeductionStock(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
    amount: number;
  }): Promise<ApplyAutoDeductionStockResult>;
}

export function isNativeAndroid(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export const AutoDeduction = registerPlugin<AutoDeductionPlugin>('AutoDeduction');
