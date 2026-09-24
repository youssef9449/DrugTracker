import type { Medication } from '../types';
import { classifyNativeError,
  nativeFailureErrorCode, toNativeBoundaryError, type NativeErrorCode } from './nativeErrors';
import { AutoDeduction, isNativeAndroid } from './autoDeductionNativePlugin';
import type {
  ApplyAutoDeductionStockResult,
  ApplyForegroundStockDeltasResult,
} from './autoDeductionNativeTypes';

export async function initializeAutoDeductionStock(
  medications: Array<{ medicationId: string; currentPills: number }>
): Promise<
  | { ok: true; medications: typeof medications }
  | {
      ok: false;
      error: string;
      errorCode: NativeErrorCode;
      medications: typeof medications;
    }
> {
  if (!isNativeAndroid()) {
    return { ok: true, medications };
  }
  try {
    const cleaned = medications
      .filter(
        (m) =>
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
        errorCode: nativeFailureErrorCode(result, 'stock_init_failed'),
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
  | {
      ok: false;
      medications: Medication[];
      error: string;
      errorCode: NativeErrorCode;
    }
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
      return next ? { ...m, currentPills: next.currentPills } : m;
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
    return {
      ok: false,
      alreadyApplied: false,
      stocks: [],
      error: 'invalid_mutation_seq',
      errorCode: 'invalid_argument',
    };
  }
  if (
    occurrenceResolutions.some(
      (resolution) =>
        typeof resolution.medicationId !== 'string' ||
        !resolution.medicationId.trim() ||
        typeof resolution.doseId !== 'string' ||
        !resolution.doseId.trim() ||
        (resolution.type !== 'CONSUMED' && resolution.type !== 'SKIPPED')
    )
  ) {
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
      return {
        ok: false,
        alreadyApplied: false,
        stocks: [],
        error: 'invalid_stock_delta',
        errorCode: 'invalid_argument',
      };
    }
    const result = await AutoDeduction.applyForegroundStockDeltas({
      mutationSeq,
      deltas: cleanDeltas,
      occurrenceResolutions: occurrenceResolutions.map((resolution) => ({
        medicationId: resolution.medicationId.trim(),
        doseId: resolution.doseId.trim(),
        calendarDate: resolution.calendarDate,
        type: resolution.type,
      })),
    });
    return result.ok
      ? result
      : {
          ...result,
          errorCode: nativeFailureErrorCode(result, 'foreground_stock_failed'),
        };
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
