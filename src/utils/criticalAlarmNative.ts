import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  classifyNativeError,
  toNativeBoundaryError,
  type NativeBoundaryFailure,
} from './nativeErrors';

export interface CriticalNativeSuccess {
  ok: true;
  status?: 'SUCCESS' | 'ALREADY_ABSENT';
}

export type CriticalNativeResult = CriticalNativeSuccess | NativeBoundaryFailure;

interface CriticalStockPlugin {
  schedule(options: {
    medicationId: string;
    medicationName: string;
    unit: string;
    triggerAtEpochMs: number;
    notificationTitle: string;
    notificationBody: string;
  }): Promise<{ ok: boolean; error?: string }>;
  cancel(options: { medicationId: string }): Promise<{
    ok: boolean;
    status?: 'SUCCESS' | 'ALREADY_ABSENT' | 'FAILED';
    error?: string;
  }>;
  verify(options: { medicationId: string; alarmTimeMs: number }): Promise<{ ok: boolean }>;
  listScheduled(): Promise<{ ids: string[] }>;
}

const CriticalStock = registerPlugin<CriticalStockPlugin>('CriticalStock');

function isAndroid(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export async function scheduleCriticalAlarmNative(
  medId: string,
  medName: string,
  criticalDateMs: number,
  unit: string,
  notificationTitle: string,
  notificationBody: string
): Promise<CriticalNativeResult> {
  if (!isAndroid()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
  }
  try {
    const result = await CriticalStock.schedule({
      medicationId: medId,
      medicationName: medName,
      unit,
      triggerAtEpochMs: criticalDateMs,
      notificationTitle,
      notificationBody,
    });
    if (result?.ok === true) {
      return { ok: true, status: 'SUCCESS' };
    }
    const message = result?.error || 'critical_schedule_failed';
    return {
      ok: false,
      error: message,
      errorCode: classifyNativeError(message),
    };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error);
    console.warn('[critical-alarm] schedule failed:', boundaryError.message);
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function cancelCriticalAlarmNative(
  medId: string
): Promise<CriticalNativeResult> {
  if (!isAndroid()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
  }
  try {
    const result = await CriticalStock.cancel({ medicationId: medId });
    if (result?.status === 'ALREADY_ABSENT' || result?.ok === true) {
      return { ok: true, status: result?.status === 'ALREADY_ABSENT' ? 'ALREADY_ABSENT' : 'SUCCESS' };
    }
    const message = result?.error || 'critical_cancel_failed';
    return {
      ok: false,
      error: message,
      errorCode: classifyNativeError(message),
    };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error);
    console.warn('[critical-alarm] cancel failed:', boundaryError.message);
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function verifyCriticalAlarmPendingNative(
  medId: string,
  alarmTimeMs: number
): Promise<
  | { ok: true; pending: boolean }
  | NativeBoundaryFailure
> {
  if (!isAndroid()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
  }
  try {
    const result = await CriticalStock.verify({ medicationId: medId, alarmTimeMs });
    return { ok: true, pending: result?.ok === true };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function listScheduledCriticalMedicationIdsNative(): Promise<
  | { ok: true; ids: string[] }
  | NativeBoundaryFailure
> {
  if (!isAndroid()) {
    return { ok: true, ids: [] };
  }
  try {
    const result = await CriticalStock.listScheduled();
    if (!Array.isArray(result?.ids)) {
      return {
        ok: false,
        error: 'critical_list_failed',
        errorCode: 'platform_failure',
      };
    }
    return { ok: true, ids: result.ids };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'persistence_failed');
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}
