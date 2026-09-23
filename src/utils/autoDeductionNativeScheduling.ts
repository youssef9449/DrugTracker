import { toNativeBoundaryError, classifyNativeError, type NativeErrorCode } from './nativeErrors';
import { AutoDeduction, isNativeAndroid } from './autoDeductionNativePlugin';
import type {
  ScheduleOccurrenceParams,
  ScheduleOccurrenceResult,
  CancelOccurrenceResult,
  RecoverAutoOccurrenceResult,
} from './autoDeductionNativeTypes';

export async function scheduleAutoDeduction(
  params: ScheduleOccurrenceParams
): Promise<ScheduleOccurrenceResult> {
  if (!isNativeAndroid()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
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
    return { ok: false, status: 'FAILED', error: 'not_android', errorCode: 'not_android' };
  }
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) {
    return { ok: false, status: 'FAILED', error: 'missing_dose_id', errorCode: 'invalid_argument' };
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
      status: 'FAILED',
      error: e instanceof Error ? e.message : 'cancel_failed',
      errorCode: toNativeBoundaryError(e).code,
    };
  }
}

export async function invalidateAutoDeductionRecurrence(
  medicationId: string,
  doseId: string
): Promise<{
  ok: boolean;
  error?: string;
  errorCode?: NativeErrorCode;
  generation?: number;
  schedulesCancelled?: boolean;
}> {
  if (!isNativeAndroid()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
  }
  try {
    const id = typeof doseId === 'string' ? doseId.trim() : '';
    if (!id) {
      return { ok: false, error: 'missing_dose_id', errorCode: 'invalid_argument' };
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
      error: e instanceof Error ? e.message : 'invalidate_failed',
      errorCode: toNativeBoundaryError(e).code,
    };
  }
}

export async function recoverAutoDeductionOccurrence(
  medicationId: string,
  doseId: string,
  calendarDate: string,
  scheduledAtEpochMs: number,
  amount: number,
  expectedRecurrenceGeneration: number
): Promise<RecoverAutoOccurrenceResult> {
  return recoverAutoDeductionOccurrenceInternal(
    medicationId,
    doseId,
    calendarDate,
    scheduledAtEpochMs,
    amount,
    expectedRecurrenceGeneration
  );
}

export async function recoverAutoDeductionOccurrenceForCompensation(
  medicationId: string,
  doseId: string,
  calendarDate: string,
  scheduledAtEpochMs: number,
  amount: number,
  expectedRecurrenceGeneration: number,
  treatmentEndDate: string | undefined,
  timeHhmm: string
): Promise<RecoverAutoOccurrenceResult> {
  return recoverAutoDeductionOccurrenceInternal(
    medicationId,
    doseId,
    calendarDate,
    scheduledAtEpochMs,
    amount,
    expectedRecurrenceGeneration,
    treatmentEndDate,
    timeHhmm
  );
}

async function recoverAutoDeductionOccurrenceInternal(
  medicationId: string,
  doseId: string,
  calendarDate: string,
  scheduledAtEpochMs: number,
  amount: number,
  expectedRecurrenceGeneration: number,
  treatmentEndDate?: string,
  timeHhmm?: string
): Promise<RecoverAutoOccurrenceResult> {
  if (
    !isNativeAndroid() ||
    !medicationId ||
    !doseId ||
    !calendarDate ||
    !Number.isFinite(scheduledAtEpochMs) ||
    scheduledAtEpochMs < 0 ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(expectedRecurrenceGeneration) ||
    expectedRecurrenceGeneration <= 0
  ) {
    return {
      ok: false,
      status: 'FAILED',
      error: 'invalid_recovery_args',
      errorCode: 'invalid_argument',
    };
  }

  try {
    const result = (timeHhmm !== undefined)
      ? await AutoDeduction.recoverMissedOccurrenceForCompensation({
          medicationId,
          doseId,
          calendarDate,
          scheduledAtEpochMs,
          amount,
          expectedRecurrenceGeneration,
          treatmentEndDate,
          timeHhmm,
        })
      : await AutoDeduction.recoverMissedOccurrence({
          medicationId,
          doseId,
          calendarDate,
          scheduledAtEpochMs,
          amount,
          expectedRecurrenceGeneration,
        });
    const boundaryError = result.ok
      ? undefined
      : classifyNativeError(result.error);
    return {
      ...result,
      errorCode: boundaryError,
    };
  } catch (e) {
    const boundaryError = toNativeBoundaryError(e, 'recovery_required');
    return {
      ok: false,
      status: 'FAILED',
      error: e instanceof Error ? e.message : 'recovery_failed',
      errorCode: boundaryError.code,
    };
  }
}
