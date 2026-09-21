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

/**
 * Generation of the last JS snapshot the native execution shadow confirmed.
 *
 * Correctness barrier: an exact Auto schedule must never be created while the
 * native shadow does not yet reflect the current durable stock generation.
 * Otherwise an alarm firing with the app closed could hit a missing or stale
 * shadow row and the closed-app deduction would fail. Every successful
 * native sync records the generation it sent; a later committed mutation
 * advances the durable generation past it and forces a fresh sync before
 * scheduling.
 */
let lastSyncedStockGeneration: number | null = null;

export function isBackgroundStockSyncedForCurrentGeneration(): boolean {
  if (!isNativeAndroid()) return true;
  return (
    lastSyncedStockGeneration != null &&
    lastSyncedStockGeneration === loadStockGeneration()
  );
}

/**
 * Validate one medication's stock value for the native execution shadow.
 *
 * Fail-closed: a corrupted stock value (undefined / NaN / '' / negative) must
 * never be coerced to 0 and mirrored into the native ledger — that would
 * silently turn unknown stock into "empty" and let Auto deduct from it.
 * The sync is refused instead; native applies the same rule independently.
 */
function isValidShadowPills(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
    const stockGeneration = loadStockGeneration();
    const nativeMedications: NativeBackgroundMedication[] = [];
    for (const med of medications) {
      if (!isValidShadowPills(med.currentPills)) {
        return {
          ok: false,
          backgroundVersion: 0,
          currentPillsByMedication: {},
          error: 'invalid_medication_snapshot',
        };
      }
      nativeMedications.push({
        medicationId: med.id,
        currentPills: med.currentPills,
      });
    }
    const result = await AutoDeduction.syncBackgroundStock({
      medications: nativeMedications,
      stockGeneration,
      alreadyAppliedOccurrences: applied.all,
      clearAppliedOccurrences,
      jsManualTakeOccurrences: applied.manualTake,
      jsRestoreOccurrences: applied.restore,
    });
    if (result.ok) {
      lastSyncedStockGeneration = stockGeneration;
    }
    return result;
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

  // Bounded convergence: each pass sends the freshest JS snapshot and adopts
  // the native result. The re-anchor pass no longer discards its returned
  // pills, so a native Auto fire landing mid-convergence is reflected in the
  // returned snapshot (or triggers one more pass) instead of leaving JS with
  // the older first-sync value until a later reconciliation.
  const MAX_PASSES = 3;
  let current = medications;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = await syncBackgroundStock(
      current,
      logs,
      pass === 0 ? clearAppliedOccurrences : []
    );
    if (!result.ok) {
      return { ok: false, medications, error: result.error };
    }
    const merged = current.map((med) => {
      const nativePills = result.currentPillsByMedication[med.id];
      return typeof nativePills === 'number' && Number.isFinite(nativePills)
        ? { ...med, currentPills: Math.max(0, nativePills) }
        : med;
    });
    const changed = merged.some(
      (med, index) => med.currentPills !== current[index].currentPills
    );
    if (!changed) {
      // Native view is consistent with the snapshot we last sent — done.
      return { ok: true, medications: merged };
    }
    const persistError = persist(STORAGE_MEDS_KEY, merged, { json: true });
    if (persistError) {
      console.warn('[App] background stock convergence could not persist JS stock:', persistError);
      return { ok: false, medications, error: persistError };
    }
    // Hydration changes the JS stock snapshot without creating a new
    // stock-mutation generation. Re-anchor the native JS baseline at the same
    // generation so the next real foreground mutation contributes only its
    // own delta.
    current = merged;
  }
  // Pass budget exhausted with a concurrent native writer still active.
  // Return the last persisted (freshest) merged snapshot; the next
  // reconciliation converges again from here.
  return { ok: true, medications: current };
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
