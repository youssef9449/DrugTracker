/**
 * Phase 2 — JS bridge to native exact-time auto-deduction.
 * Safe on web (no-ops). Does NOT reconcile stock (Phase 3).
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { LEGACY_DOSE_ID } from './notifications';

export interface AutoDeductionEvent {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  scheduledAtEpochMs: number;
  amount: number;
  status: 'FIRED' | 'RECONCILED' | string;
  createdAtEpochMs: number;
  reconciledAtEpochMs: number | null;
}

export interface MarkReconciledResult {
  ok: boolean;
  changed: boolean;
}

export interface ScheduleOccurrenceParams {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  timeHhmm: string;
  amount: number;
  scheduledAtEpochMs?: number;
}

export interface ScheduleOccurrenceResult {
  ok: boolean;
  error?: string;
  occurrenceKey?: string;
}

export type CancelOccurrenceStatus = "SUCCESS" | "ALREADY_ABSENT" | "FAILED";

export interface CancelOccurrenceResult {
  ok: boolean;
  status: CancelOccurrenceStatus;
  error?: string;
}

interface AutoDeductionPlugin {
  scheduleOccurrence(options: ScheduleOccurrenceParams): Promise<ScheduleOccurrenceResult>;
  cancelOccurrence(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }): Promise<CancelOccurrenceResult>;
  listFiredEvents(): Promise<{ events: AutoDeductionEvent[] }>;
  listEvents(): Promise<{ events: AutoDeductionEvent[] }>;
  markReconciled(options: {
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }): Promise<MarkReconciledResult>;
  canScheduleExactAlarms(): Promise<{ granted: boolean }>;
  restoreFutureSchedules(): Promise<{ restored: number }>;
}

const AutoDeduction = registerPlugin<AutoDeductionPlugin>('AutoDeduction');

function isNativeAndroid(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export function autoDeductionOccurrenceKey(
  medicationId: string,
  doseId: string,
  calendarDate: string
): string {
  return `${medicationId}\u001f${doseId}\u001f${calendarDate}`;
}

export async function scheduleAutoDeduction(
  params: ScheduleOccurrenceParams
): Promise<ScheduleOccurrenceResult> {
  if (!isNativeAndroid()) {
    return { ok: false, error: 'not_android' };
  }
  if (!(Number(params.amount) > 0) || !Number.isFinite(Number(params.amount))) {
    return { ok: false, error: 'invalid_amount' };
  }
  try {
    return await AutoDeduction.scheduleOccurrence({
      ...params,
      amount: Number(params.amount),
      doseId: params.doseId || LEGACY_DOSE_ID,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'schedule_failed' };
  }
}

export async function cancelAutoDeduction(
  medicationId: string,
  doseId: string,
  calendarDate: string
): Promise<CancelOccurrenceResult> {
  if (!isNativeAndroid()) {
    return { ok: false, status: "FAILED", error: "not_android" };
  }
  try {
    return await AutoDeduction.cancelOccurrence({
      medicationId,
      doseId: doseId || LEGACY_DOSE_ID,
      calendarDate,
    });
  } catch (e) {
    return {
      ok: false,
      status: "FAILED",
      error: e instanceof Error ? e.message : "cancel_failed",
    };
  }
}

export async function listFiredAutoDeductionEvents(): Promise<AutoDeductionEvent[]> {
  if (!isNativeAndroid()) return [];
  try {
    const res = await AutoDeduction.listFiredEvents();
    return res.events ?? [];
  } catch {
    return [];
  }
}

export async function listAutoDeductionEvents(): Promise<AutoDeductionEvent[]> {
  if (!isNativeAndroid()) return [];
  try {
    const res = await AutoDeduction.listEvents();
    return res.events ?? [];
  } catch {
    return [];
  }
}

export async function markAutoDeductionEventReconciled(
  medicationId: string,
  doseId: string,
  calendarDate: string
): Promise<MarkReconciledResult> {
  if (!isNativeAndroid()) return { ok: false, changed: false };
  try {
    return await AutoDeduction.markReconciled({
      medicationId,
      doseId: doseId || LEGACY_DOSE_ID,
      calendarDate,
    });
  } catch {
    return { ok: false, changed: false };
  }
}

export async function canScheduleAutoDeductionExactAlarms(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await AutoDeduction.canScheduleExactAlarms();
    return res.granted === true;
  } catch {
    return false;
  }
}

export async function restoreFutureAutoDeductionSchedules(): Promise<number> {
  if (!isNativeAndroid()) return 0;
  try {
    const res = await AutoDeduction.restoreFutureSchedules();
    return res.restored ?? 0;
  } catch {
    return 0;
  }
}
