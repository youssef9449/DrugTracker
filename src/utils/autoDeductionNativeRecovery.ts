import { toNativeBoundaryError, classifyNativeError } from './nativeErrors';
import { AutoDeduction, isNativeAndroid } from './autoDeductionNativePlugin';
import type { ListScheduledOccurrencesResult, RestoreFutureSchedulesResult } from './autoDeductionNativeTypes';

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
