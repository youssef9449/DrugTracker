import type { Medication } from '../types';
import { classifyNativeError, toNativeBoundaryError, type NativeErrorCode } from './nativeErrors';
import { AutoDeduction, isNativeAndroid } from './autoDeductionNativePlugin';
import type {
  ApplyAutoDeductionStockResult,
  ApplyForegroundStockDeltasResult,
  InitializeNativeStockResult,
} from './autoDeductionNativeTypes';

export async function initializeAutoDeductionStock(
  medications: Array<{ medicationId: string; currentPills: number }

export async function convergeAutoDeductionStock(
  medications: Medication[]
): Promise<
  | { ok: true; medications: Medication[] }

export async function applyForegroundAutoStockDeltas(
  mutationSeq: number,
  deltas: Array<{ medicationId: string; delta: number }

export async function recoverAutoDeductionStock(
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
    const result = await AutoDeduction.recoverAutoDeductionStock({
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
      error: e instanceof Error ? e.message : 'auto_stock_recovery_failed',
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
