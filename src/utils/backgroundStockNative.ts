import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ConsumptionLog, Medication } from '../types';
import { loadStockGeneration, STORAGE_MEDS_KEY } from './autoDeductionStockGate';
import { persist } from './storage';

interface NativeBackgroundMedication {
  medicationId: string;
  currentPills: number;
}
interface NativeBackgroundSyncResult {
  ok: boolean;
  backgroundVersion: number;
  currentPillsByMedication: Record<string, number>;
  error?: string;
}
interface NativeBackgroundStockPlugin {
  syncBackgroundStock(options: {
    medications: NativeBackgroundMedication[];
    stockGeneration: number;
    alreadyAppliedOccurrences: string[];
    clearAppliedOccurrences: string[];
    jsManualTakeOccurrences: string[];
    jsRestoreOccurrences: string[];
  }): Promise<NativeBackgroundSyncResult>;
  repairBackgroundStockFromFiredEvents(): Promise<{
    ok: boolean;
    repaired: number;
    error?: string;
  }>;
  getBackgroundStockSnapshot(): Promise<{
    ok: boolean;
    backgroundVersion: number;
    currentPillsByMedication: Record<string, number>;
    error?: string;
  }>;
}
const AutoDeduction = registerPlugin<NativeBackgroundStockPlugin>('AutoDeduction');

function isNativeAndroid(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}
function occurrenceKey(medicationId: string, doseId: string, calendarDate: string): string {
  return `${medicationId}\u001f${doseId}\u001f${calendarDate}`;
}
function buildAppliedOccurrenceSets(
  medications: Medication[],
  logs: ConsumptionLog[]
): {
  all: string[];
  manualTake: string[];
  restore: string[];
} {
  const all = new Set<string>();
  const manualTake = new Set<string>();
  const restore = new Set<string>();

  for (const log of logs) {
    if (!log.doseId || !log.medicationId || !log.date || log.reversedAt) continue;
    const key = occurrenceKey(
      log.medicationId,
      String(log.doseId).trim(),
      log.date
    );
    if (log.type === 'exact_auto' || log.type === 'dose_taken') {
      all.add(key);
    }
    if (log.type === 'dose_taken' && Number(log.amount) > 0) {
      manualTake.add(key);
    }
    if (log.type === 'skipped_day' && Number(log.amount) > 0) {
      // A skipped_day log is Restore evidence, not by itself proof that the
      // occurrence must remain blocked forever. In particular, Restore performed
      // before today's scheduled time must leave the occurrence eligible for the
      // future exact Auto fire. Active past-due skip state is represented by
      // doseSkippedHistory below; keep the log only as restore-race metadata.
      restore.add(key);
    }
  }

  for (const med of medications) {
    const consumed = med.doseConsumptionHistory ?? {};
    const skipped = med.doseSkippedHistory ?? {};
    for (const [doseId, dates] of Object.entries(consumed)) {
      if (!Array.isArray(dates)) continue;
      for (const date of dates) {
        if (typeof date === 'string' && date) {
          all.add(occurrenceKey(med.id, String(doseId).trim(), date));
        }
      }
    }
    for (const [doseId, dates] of Object.entries(skipped)) {
      if (!Array.isArray(dates)) continue;
      for (const date of dates) {
        if (typeof date === 'string' && date) {
          all.add(occurrenceKey(med.id, String(doseId).trim(), date));
          restore.add(occurrenceKey(med.id, String(doseId).trim(), date));
        }
      }
    }
  }

  return {
    all: [...all],
    manualTake: [...manualTake],
    restore: [...restore],
  };
}
export async function syncBackgroundStock(
  medications: Medication[],
  logs: ConsumptionLog[] = [],
  clearAppliedOccurrences: string[] = []
): Promise<NativeBackgroundSyncResult> {
  if (!isNativeAndroid()) {
    return {
      ok: true,
      backgroundVersion: 0,
      currentPillsByMedication: Object.fromEntries(
        medications.map((m) => [m.id, Math.max(0, Number(m.currentPills) || 0)])
      ),
    };
  }
  try {
    const applied = buildAppliedOccurrenceSets(medications, logs);
    return await AutoDeduction.syncBackgroundStock({
      medications: medications.map((med) => ({
        medicationId: med.id,
        currentPills: Math.max(0, Number(med.currentPills) || 0),
      })),
      stockGeneration: loadStockGeneration(),
      alreadyAppliedOccurrences: applied.all,
      clearAppliedOccurrences,
      jsManualTakeOccurrences: applied.manualTake,
      jsRestoreOccurrences: applied.restore,
    });
  } catch (e) {
    return {
      ok: false,
      backgroundVersion: 0,
      currentPillsByMedication: {},
      error: e instanceof Error ? e.message : 'background_stock_sync_failed',
    };
  }
}
export interface BackgroundStockConvergenceResult {
  ok: boolean;
  medications: Medication[];
  error?: string;
}

export async function convergeBackgroundStock(
  medications: Medication[],
  logs: ConsumptionLog[] = [],
  clearAppliedOccurrences: string[] = []
): Promise<BackgroundStockConvergenceResult> {

  if (!isNativeAndroid()) {
    return { ok: true, medications };
  }

  const result = await syncBackgroundStock(
    medications,
    logs,
    clearAppliedOccurrences
  );
  if (!result.ok) {
    return { ok: false, medications, error: result.error };
  }
  const merged = medications.map((med) => {
    const nativePills = result.currentPillsByMedication[med.id];
    return typeof nativePills === 'number' && Number.isFinite(nativePills)
      ? { ...med, currentPills: Math.max(0, nativePills) }
      : med;
  });
  const changed = merged.some(
    (med, index) => med.currentPills !== medications[index].currentPills
  );
  if (changed) {
    const persistError = persist(STORAGE_MEDS_KEY, merged, { json: true });
    if (persistError) {
      console.warn('[App] background stock convergence could not persist JS stock:', persistError);
      return { ok: false, medications, error: persistError };
    }
    // Hydration changes the JS stock snapshot without creating a new
    // stock-mutation generation. Re-anchor the native JS baseline at the same
    // generation so the next real foreground mutation contributes only its
    // own delta.
    const reanchor = await syncBackgroundStock(merged, logs);
    if (!reanchor.ok) {
      console.warn('[App] background stock re-anchor failed:', reanchor.error);
      return { ok: false, medications, error: reanchor.error };
    }
  }
  return { ok: true, medications: merged };
}

export async function repairBackgroundStockFromFiredEvents(): Promise<{
  ok: boolean;
  repaired: number;
  error?: string;
}> {
  if (!isNativeAndroid()) {
    return { ok: true, repaired: 0 };
  }
  try {
    return await AutoDeduction.repairBackgroundStockFromFiredEvents();
  } catch (e) {
    return {
      ok: false,
      repaired: 0,
      error: e instanceof Error ? e.message : 'background_stock_repair_failed',
    };
  }
}

export async function hydrateBackgroundStock(
  medications: Medication[],
  logs: ConsumptionLog[] = []
): Promise<Medication[]> {
  const result = await convergeBackgroundStock(medications, logs);
  return result.medications;
}

export async function getBackgroundStockSnapshot(): Promise<{
  ok: boolean;
  backgroundVersion: number;
  currentPillsByMedication: Record<string, number>;
  error?: string;
}> {
  if (!isNativeAndroid()) {
    return { ok: true, backgroundVersion: 0, currentPillsByMedication: {} };
  }
  try {
    return await AutoDeduction.getBackgroundStockSnapshot();
  } catch (e) {
    return {
      ok: false,
      backgroundVersion: 0,
      currentPillsByMedication: {},
      error: e instanceof Error ? e.message : 'background_stock_snapshot_failed',
    };
  }
}
