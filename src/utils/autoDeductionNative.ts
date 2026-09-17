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
  status: 'FIRED' | 'RECONCILED' | 'REJECTED' | string;
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

export interface ScheduledOccurrence {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  timeHhmm?: string;
  amount?: number;
  scheduledAtEpochMs?: number;
}

/**
 * Explicit result for native schedule listing (Issue #242).
 * Successful empty list: { ok: true, schedules: [] }
 * Native read failure:  { ok: false, schedules: [], error }
 * Never conflate the two — callers must check ok before treating schedules
 * as an authoritative native snapshot.
 */
export interface ListScheduledOccurrencesResult {
  ok: boolean;
  schedules: ScheduledOccurrence[];
  error?: string;
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
  /** Issue #217 — bump recurrence generation + cancel all futures for dose slot. */
  invalidateRecurrenceAuthorization(options: {
    medicationId: string;
    doseId: string;
  }): Promise<{ ok: boolean; error?: string; generation?: number }>;
  listFiredEvents(): Promise<{ events: AutoDeductionEvent[] }>;
  listEvents(): Promise<{ events: AutoDeductionEvent[] }>;
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
  canScheduleExactAlarms(): Promise<{ granted: boolean }>;
  restoreFutureSchedules(): Promise<{ restored: number }>;
  listScheduledOccurrences(): Promise<{ schedules: ScheduledOccurrence[] }>;
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

/**
 * Issue #217: disable recurrence for a medication+dose schedule chain.
 * Bumps durable generation under native SCHEDULE_LOCK and cancels all
 * future scheduled occurrences for that slot so post-fire D+1 cannot be
 * created or restored after auto-deduction is turned off.
 */
export async function invalidateAutoDeductionRecurrence(
  medicationId: string,
  doseId: string
): Promise<{ ok: boolean; error?: string; generation?: number }> {
  if (!isNativeAndroid()) {
    return { ok: false, error: "not_android" };
  }
  try {
    // Pass through native ok/error — never coerce a failed generation commit
    // into success (fail-closed for Issue #217 recurrence authorization).
    return await AutoDeduction.invalidateRecurrenceAuthorization({
      medicationId,
      doseId: doseId || LEGACY_DOSE_ID,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "invalidate_failed",
    };
  }
}

/**
 * Explicit result for native FIRED event listing (mirrors scheduled-occurrence listing).
 * Successful empty list: { ok: true, events: [] }
 * Native read failure:  { ok: false, events: [], error }
 * Never conflate the two — callers must check ok before treating events as authoritative.
 */
export interface ListFiredEventsResult {
  ok: boolean;
  events: AutoDeductionEvent[];
  error?: string;
}

export async function listFiredAutoDeductionEvents(): Promise<ListFiredEventsResult> {
  if (!isNativeAndroid()) {
    return { ok: true, events: [] };
  }
  try {
    const res = await AutoDeduction.listFiredEvents();
    return { ok: true, events: res.events ?? [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'list_fired_failed';
    return { ok: false, events: [], error: msg };
  }
}


export type OccurrenceSnapshotStatus = 'FIRED' | 'SCHEDULED' | 'CANCELLED' | 'ABSENT';

export type OccurrenceSnapshotResult =
  | { ok: true; status: OccurrenceSnapshotStatus; amount?: number }
  | { ok: false; error: string };

/**
 * Atomic native occurrence snapshot under SCHEDULE_LOCK.
 * On non-Android: returns ok:true ABSENT (caller uses durable JS schedule).
 * On native failure: ok:false — never faked as ABSENT.
 */
export async function getOccurrenceSnapshot(
  medicationId: string,
  doseId: string,
  calendarDate: string
): Promise<OccurrenceSnapshotResult> {
  if (!isNativeAndroid()) {
    return { ok: true, status: 'ABSENT' };
  }
  try {
    const res = await AutoDeduction.getOccurrenceSnapshot({
      medicationId,
      doseId: doseId || LEGACY_DOSE_ID,
      calendarDate,
    });
    if (!res || res.ok === false) {
      return {
        ok: false,
        error: (res && res.error) || 'snapshot_failed',
      };
    }
    const statusRaw = String(res.status || '').toUpperCase();
    const allowed: OccurrenceSnapshotStatus[] = [
      'FIRED',
      'SCHEDULED',
      'CANCELLED',
      'ABSENT',
    ];
    if (!allowed.includes(statusRaw as OccurrenceSnapshotStatus)) {
      return { ok: false, error: 'invalid_snapshot_status' };
    }
    const status = statusRaw as OccurrenceSnapshotStatus;
    const amount =
      res.amount != null && Number.isFinite(Number(res.amount))
        ? Number(res.amount)
        : undefined;
    return { ok: true, status, amount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'snapshot_failed';
    return { ok: false, error: msg };
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

export async function listScheduledAutoDeductionOccurrences(): Promise<ListScheduledOccurrencesResult> {
  // Web / non-Android: no native AlarmManager — successful empty set (not a failure).
  if (!isNativeAndroid()) {
    return { ok: true, schedules: [] };
  }
  try {
    const res = await AutoDeduction.listScheduledOccurrences();
    return { ok: true, schedules: res.schedules ?? [] };
  } catch (e) {
    return {
      ok: false,
      schedules: [],
      error: e instanceof Error ? e.message : 'list_schedules_failed',
    };
  }
}
