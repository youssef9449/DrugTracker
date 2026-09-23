/**
 * JS bridge to the Exact Auto native scheduler and Native stock authority.
 * Safe on web (native stock operations are no-ops there).
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Medication } from '../types';
import { classifyNativeError, toNativeBoundaryError, type NativeErrorCode } from './nativeErrors';

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

export async function initializeAutoDeductionStock(
  medications: Array<{ medicationId: string; currentPills: number }>
): Promise<
  | { ok: true; medications: typeof medications }
  | { ok: false; error: string; errorCode: NativeErrorCode; medications: typeof medications }
> {
  if (!isNativeAndroid()) {
    return { ok: true, medications };
  }
  try {
    const cleaned = medications
      .filter((m) =>
        typeof m.medicationId === 'string' &&
        m.medicationId.trim().length > 0 &&
        Number.isFinite(Number(m.currentPills)) &&
        Number(m.currentPills) >= 0
      )
      .map((m) => ({
        medicationId: m.medicationId.trim(),
        currentPills: Number(m.currentPills),
      }));
    const result = await AutoDeduction.initializeStock({
      medications: cleaned,
    });
    if (!result || result.ok === false) {
      return {
        ok: false,
        error: result?.error || 'stock_init_failed',
        errorCode: classifyNativeError(result?.error || 'stock_init_failed'),
        medications,
      };
    }
    const byId = new Map(
      (result.stocks ?? []).map((s) => [
        String(s.medicationId).trim(),
        Number(s.currentPills),
      ])
    );
    const next = medications.map((m) => {
      const value = byId.get(m.medicationId);
      return value != null && Number.isFinite(value) && value >= 0
        ? { ...m, currentPills: value }
        : m;
    });
    return { ok: true, medications: next };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'stock_init_failed',
      errorCode: toNativeBoundaryError(e, 'persistence_failed').code,
      medications,
    };
  }
}

export async function convergeAutoDeductionStock(
  medications: Medication[]
): Promise<
  | { ok: true; medications: Medication[] }
  | { ok: false; medications: Medication[]; error: string; errorCode: NativeErrorCode }
> {
  const result = await initializeAutoDeductionStock(
    medications.map((m) => ({
      medicationId: m.id,
      currentPills: m.currentPills,
    }))
  );
  if (!result.ok) {
    return {
      ok: false,
      medications,
      error: result.error,
      errorCode: result.errorCode,
    };
  }
  return {
    ok: true,
    medications: medications.map((m) => {
      const next = result.medications.find((x) => x.medicationId === m.id);
      return next
        ? { ...m, currentPills: next.currentPills }
        : m;
    }),
  };
}

export async function applyForegroundAutoStockDeltas(
  mutationSeq: number,
  deltas: Array<{ medicationId: string; delta: number }>,
  occurrenceResolutions: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
    type: 'CONSUMED' | 'SKIPPED';
  }> = []
): Promise<ApplyForegroundStockDeltasResult> {
  if (!isNativeAndroid()) {
    return { ok: true, alreadyApplied: false, stocks: [] };
  }
  if (!(mutationSeq > 0)) {
    return { ok: false, alreadyApplied: false, stocks: [], error: 'invalid_mutation_seq', errorCode: 'invalid_argument' };
  }
  if (occurrenceResolutions.some((resolution) =>
    typeof resolution.medicationId !== 'string' ||
    !resolution.medicationId.trim() ||
    typeof resolution.doseId !== 'string' ||
    !resolution.doseId.trim() ||
    (resolution.type !== 'CONSUMED' && resolution.type !== 'SKIPPED')
  )) {
    return {
      ok: false,
      alreadyApplied: false,
      stocks: [],
      error: 'invalid_occurrence_resolution',
      errorCode: 'invalid_argument',
    };
  }
  try {
    const cleanDeltas = deltas
      .filter((d) => typeof d.medicationId === 'string' && d.medicationId.trim())
      .map((d) => ({
        medicationId: d.medicationId.trim(),
        delta: Number(d.delta),
      }));
    if (cleanDeltas.some((d) => !Number.isFinite(d.delta))) {
      return { ok: false, alreadyApplied: false, stocks: [], error: 'invalid_stock_delta', errorCode: 'invalid_argument' };
    }
    return await AutoDeduction.applyForegroundStockDeltas({
      mutationSeq,
      deltas: cleanDeltas,
      occurrenceResolutions: occurrenceResolutions.map((resolution) => ({
        medicationId: resolution.medicationId.trim(),
        doseId: resolution.doseId.trim(),
        calendarDate: resolution.calendarDate,
        type: resolution.type,
      })),
    });
  } catch (e) {
    return {
      ok: false,
      alreadyApplied: false,
      stocks: [],
      error: e instanceof Error ? e.message : 'foreground_stock_failed',
      errorCode: toNativeBoundaryError(e, 'persistence_failed').code,
    };
  }
}

export async function applyAutoDeductionStock(
  medicationId: string,
  doseId: string,
  calendarDate: string,
  amount: number
): Promise<ApplyAutoDeductionStockResult> {
  if (!isNativeAndroid()) {
    return {
      ok: true,
      native: false,
      applied: false,
      actualDeducted: 0,
      currentPills: 0,
    };
  }
  if (
    typeof medicationId !== 'string' ||
    !medicationId.trim() ||
    typeof doseId !== 'string' ||
    !doseId.trim() ||
    !Number.isFinite(Number(amount)) ||
    Number(amount) <= 0
  ) {
    return {
      ok: false,
      native: true,
      applied: false,
      actualDeducted: 0,
      currentPills: 0,
      error: 'invalid_auto_stock_args',
      errorCode: 'invalid_argument',
    };
  }
  try {
    const result = await AutoDeduction.applyAutoDeductionStock({
      medicationId,
      doseId,
      calendarDate,
      amount: Number(amount),
    });
    return {
      ...result,
      ...(result.ok === false ? { errorCode: classifyNativeError(result.error) } : {}),
      native: true,
    };
  } catch (e) {
    return {
      ok: false,
      native: true,
      applied: false,
      actualDeducted: 0,
      currentPills: 0,
      error: e instanceof Error ? e.message : 'auto_stock_failed',
      errorCode: toNativeBoundaryError(e, 'persistence_failed').code,
    };
  }
}

export async function scheduleAutoDeduction(
  params: ScheduleOccurrenceParams
): Promise<ScheduleOccurrenceResult> {
  if (!isNativeAndroid()) {
    return { ok: false, error: 'not_android' };
  }
  if (!(Number(params.amount) > 0) || !Number.isFinite(Number(params.amount))) {
    return { ok: false, error: 'invalid_amount', errorCode: 'invalid_argument' };
  }
  const doseId = typeof params.doseId === 'string' ? params.doseId.trim() : '';
  if (!doseId) {
    return { ok: false, error: 'missing_dose_id', errorCode: 'invalid_argument' };
  }
  try {
    const result = await AutoDeduction.scheduleOccurrence({
      ...params,
      amount: Number(params.amount),
      doseId,
    });
    return result.ok
      ? result
      : { ...result, errorCode: classifyNativeError(result.error) };
  } catch (e) {
    const boundaryError = toNativeBoundaryError(e);
    return { ok: false, error: boundaryError.message, errorCode: boundaryError.code };
  }
}

export async function cancelAutoDeduction(
  medicationId: string,
  doseId: string,
  calendarDate: string
): Promise<CancelOccurrenceResult> {
  if (!isNativeAndroid()) {
    return { ok: false, status: "FAILED", error: "not_android", errorCode: "not_android" };
  }
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) {
    return { ok: false, status: "FAILED", error: "missing_dose_id", errorCode: "invalid_argument" };
  }
  try {
    const result = await AutoDeduction.cancelOccurrence({
      medicationId,
      doseId: id,
      calendarDate,
    });
    return result.ok
      ? result
      : { ...result, errorCode: classifyNativeError(result.error) };
  } catch (e) {
    return {
      ok: false,
      status: "FAILED",
      error: e instanceof Error ? e.message : "cancel_failed",
      errorCode: toNativeBoundaryError(e).code,
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
    return { ok: false, error: "not_android", errorCode: "not_android" };
  }
  try {
    // Pass through native ok/error — never coerce a failed generation commit
    // into success (fail-closed for Issue #217 recurrence authorization).
    const id = typeof doseId === 'string' ? doseId.trim() : '';
    if (!id) {
      return { ok: false, error: "missing_dose_id", errorCode: "invalid_argument" };
    }
    const result = await AutoDeduction.invalidateRecurrenceAuthorization({
      medicationId,
      doseId: id,
    });
    return result.ok
      ? result
      : { ...result, errorCode: classifyNativeError(result.error) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "invalidate_failed",
      errorCode: toNativeBoundaryError(e).code,
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
  errorCode?: NativeErrorCode;
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
        errorCode: classifyNativeError(res?.error || 'list_fired_failed'),
      };
    }
    return { ok: true, events: res.events ?? [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'list_fired_failed';
    return { ok: false, events: [], error: msg, errorCode: toNativeBoundaryError(e, 'persistence_failed').code };
  }
}


export type OccurrenceSnapshotStatus = 'FIRED' | 'SCHEDULED' | 'CANCELLED' | 'ABSENT';

export type OccurrenceSnapshotResult =
  | { ok: true; status: OccurrenceSnapshotStatus; amount?: number }
  | { ok: false; error: string; errorCode: NativeErrorCode };

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
    return { ok: false, error: 'missing_dose_id', errorCode: 'invalid_argument' };
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
        errorCode: classifyNativeError(res?.error || 'snapshot_failed'),
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
      return { ok: false, error: 'invalid_snapshot_status', errorCode: 'invalid_argument' };
    }
    const status = statusRaw as OccurrenceSnapshotStatus;
    const amount =
      res.amount != null && Number.isFinite(Number(res.amount))
        ? Number(res.amount)
        : undefined;
    return { ok: true, status, amount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'snapshot_failed';
    return { ok: false, error: msg, errorCode: toNativeBoundaryError(e, 'persistence_failed').code };
  }
}


export async function markAutoDeductionEventReconciled(
  medicationId: string,
  doseId: string,
  calendarDate: string
): Promise<MarkReconciledResult> {
  if (!isNativeAndroid()) return { ok: false, changed: false, error: 'not_android', errorCode: 'not_android' };
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) {
    return { ok: false, changed: false };
  }
  try {
    const result = await AutoDeduction.markReconciled({
      medicationId,
      doseId: id,
      calendarDate,
    });
    return result.ok
      ? result
      : { ...result, error: 'mark_reconciled_failed', errorCode: 'persistence_failed' };
  } catch (e) {
    const boundaryError = toNativeBoundaryError(e, 'persistence_failed');
    return { ok: false, changed: false, error: boundaryError.message, errorCode: boundaryError.code };
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
      ...(ok ? {} : { errorCode: classifyNativeError(res?.error || 'restore_failed') }),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'restore_failed';
    return { ok: false, restored: 0, failed: 0, error: msg, errorCode: toNativeBoundaryError(e, 'recovery_required').code };
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
      errorCode: toNativeBoundaryError(e, 'persistence_failed').code,
    };
  }
}


