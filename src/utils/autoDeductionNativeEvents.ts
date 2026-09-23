import type { PluginListenerHandle } from '@capacitor/core';
import { classifyNativeError, toNativeBoundaryError, type NativeErrorCode } from './nativeErrors';
import { AutoDeduction, isNativeAndroid } from './autoDeductionNativePlugin';
import type { AutoDeductionEvent, ExactAutoDeductionFiredEvent, MarkReconciledResult } from './autoDeductionNativeTypes';

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
 * Native fail-closed contract: when the EventStore cannot durably
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
    return {
      ok: false,
      changed: false,
      error: 'missing_dose_id',
      errorCode: 'invalid_argument',
    };
  }
  try {
    const result = await AutoDeduction.markReconciled({
      medicationId,
      doseId: id,
      calendarDate,
    });
    if (result.ok) return result;
    const message = result.error || 'mark_reconciled_failed';
    return {
      ...result,
      error: message,
      errorCode: classifyNativeError(message),
    };
  } catch (e) {
    const boundaryError = toNativeBoundaryError(e, 'persistence_failed');
    return { ok: false, changed: false, error: boundaryError.message, errorCode: boundaryError.code };
  }
}
