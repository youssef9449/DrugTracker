/**
 * Phase 2 — JS bridge to native exact-time auto-deduction.
 * Safe on web (no-ops). Does NOT reconcile stock (Phase 3).
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

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
  /** Durable native marker: fire persistence is pending retry/recovery. */
  fireRetryCount?: number;
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
  fireRetryCount?: number;
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
}

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
  /** Issue #217 — bump recurrence generation + cancel all futures for dose slot. */
  invalidateRecurrenceAuthorization(options: {
    medicationId: string;
    doseId: string;
  }): Promise<{ ok: boolean; error?: string; generation?: number }>;
  listFiredEvents(): Promise<{ ok: boolean; events: AutoDeductionEvent[]; error?: string }>;
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
  restoreFutureSchedules(): Promise<RestoreFutureSchedulesResult>;
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
  const doseId = typeof params.doseId === 'string' ? params.doseId.trim() : '';
  if (!doseId) {
    return { ok: false, error: 'missing_dose_id' };
  }
  try {
    return await AutoDeduction.scheduleOccurrence({
      ...params,
      amount: Number(params.amount),
      doseId,
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
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) {
    return { ok: false, status: "FAILED", error: "missing_dose_id" };
  }
  try {
    return await AutoDeduction.cancelOccurrence({
      medicationId,
      doseId: id,
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
    const id = typeof doseId === 'string' ? doseId.trim() : '';
    if (!id) {
      return { ok: false, error: "missing_dose_id" };
    }
    return await AutoDeduction.invalidateRecurrenceAuthorization({
      medicationId,
      doseId: id,
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

export function addExactAutoDeductionFiredListener(
  listener: (event: ExactAutoDeductionFiredEvent) => void
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroid()) {
    return Promise.resolve(null);
  }
  return AutoDeduction.addListener('exactAutoDeductionFired', listener);
}

export async function listFiredAutoDeductionEvents(): Promise<ListFiredEventsResult> {
  if (!isNativeAndroid()) {
    return { ok: true, events: [] };
  }
  try {
    const res = await AutoDeduction.listFiredEvents();
    if (!res || res.ok === false) {
      return {
        ok: false,
        events: [],
        error: (res && res.error) || 'list_fired_failed',
      };
    }
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
 *
 * Native fail-closed contract (Phase 4): when the EventStore cannot durably
 * read/terminalize a malformed or identity-mismatched FIRED row, the native
 * snapshot reports an explicit failure (ok=false, error
 * 'rejected_persist_failed') through this bridge — the gated Manual Take
 * consumer must fail closed (no stock mutation, no log, no JS schedule
 * fallback).
 */
export async function getOccurrenceSnapshot(
  medicationId: string,
  doseId: string,
  calendarDate: string
): Promise<OccurrenceSnapshotResult> {
  if (!isNativeAndroid()) {
    return { ok: true, status: 'ABSENT' };
  }
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) {
    return { ok: false, error: 'missing_dose_id' };
  }
  try {
    const res = await AutoDeduction.getOccurrenceSnapshot({
      medicationId,
      doseId: id,
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


export async function markAutoDeductionEventReconciled(
  medicationId: string,
  doseId: string,
  calendarDate: string
): Promise<MarkReconciledResult> {
  if (!isNativeAndroid()) return { ok: false, changed: false };
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) {
    return { ok: false, changed: false };
  }
  try {
    return await AutoDeduction.markReconciled({
      medicationId,
      doseId: id,
      calendarDate,
    });
  } catch {
    return { ok: false, changed: false };
  }
}

/**
 * Issue #242 contract: surface the native future-schedule restore result
 * without conflating failure with "nothing to restore". Web / non-Android
 * has no native AlarmManager ledger — a successful no-op (not a failure).
 */
export async function restoreFutureAutoDeductionSchedules(): Promise<RestoreFutureSchedulesResult> {
  if (!isNativeAndroid()) {
    return { ok: true, restored: 0, failed: 0 };
  }
  try {
    const res = await AutoDeduction.restoreFutureSchedules();
    const ok = res != null && res.ok !== false;
    return {
      ok,
      restored: Number(res?.restored) || 0,
      failed: Number(res?.failed) || 0,
      error: res?.error,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'restore_failed';
    return { ok: false, restored: 0, failed: 0, error: msg };
  }
}

/**
 * Issue #242 contract: explicit result for native schedule listing.
 * Successful empty list: { ok: true, schedules: [] }
 * Native read failure:  { ok: false, schedules: [], error }
 * Web / non-Android: no native AlarmManager — successful empty set (not a failure).
 */
export async function listScheduledAutoDeductionOccurrences(): Promise<ListScheduledOccurrencesResult> {
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


