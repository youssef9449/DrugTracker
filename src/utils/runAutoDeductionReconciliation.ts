/**
 * Phase 3 — orchestrate native FIRED → JS apply → persist → mark RECONCILED.
 * Serialized via module-level promise chain (no concurrent reconciles).
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  listFiredAutoDeductionEvents,
  markAutoDeductionEventReconciled,
  type AutoDeductionEvent,
} from './autoDeductionNative';
import { reconcileFiredEvents, type ReconcileFiredResult } from './autoDeductionReconciliation';
import { persist } from './storage';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';

export interface RunReconciliationInput {
  medications: Medication[];
  logs: ConsumptionLog[];
  globalAutoDeductEnabled: boolean;
  /** Optional inject for tests */
  listFired?: () => Promise<AutoDeductionEvent[]>;
  markReconciled?: (medicationId: string, doseId: string, calendarDate: string) => Promise<void>;
  persistMeds?: (meds: Medication[]) => string | null;
  persistLogs?: (logs: ConsumptionLog[]) => string | null;
  now?: Date;
}

export interface RunReconciliationOutput extends ReconcileFiredResult {
  /** Native mark attempts that completed without throw */
  markedCount: number;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Serialize reconciliation so startup + resume cannot apply the same event twice in parallel.
 */
export function runAutoDeductionReconciliation(
  input: RunReconciliationInput
): Promise<RunReconciliationOutput> {
  const job = chain.then(() => runOnce(input), () => runOnce(input));
  chain = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}

async function runOnce(input: RunReconciliationInput): Promise<RunReconciliationOutput> {
  const listFired = input.listFired ?? listFiredAutoDeductionEvents;
  const mark =
    input.markReconciled ??
    (async (medicationId: string, doseId: string, calendarDate: string) => {
      await markAutoDeductionEventReconciled(medicationId, doseId, calendarDate);
    });
  const persistMeds =
    input.persistMeds ??
    ((meds: Medication[]) => persist(STORAGE_MEDS_KEY, meds, { json: true }));
  const persistLogs =
    input.persistLogs ??
    ((logs: ConsumptionLog[]) => persist(STORAGE_LOGS_KEY, logs, { json: true }));

  let events: AutoDeductionEvent[] = [];
  try {
    events = await listFired();
  } catch {
    events = [];
  }

  if (!events.length) {
    return {
      medications: input.medications,
      logs: input.logs,
      toAcknowledge: [],
      details: [],
      mutated: false,
      markedCount: 0,
    };
  }

  const result = reconcileFiredEvents(input.medications, input.logs, events, {
    globalAutoDeductEnabled: input.globalAutoDeductEnabled,
    now: input.now,
  });

  // Persist JS state BEFORE native mark — crash window is then safe:
  // restart sees consumption marker → already_applied → mark only.
  if (result.mutated) {
    const medErr = persistMeds(result.medications);
    const logErr = persistLogs(result.logs);
    if (medErr || logErr) {
      // Persistence failed: do NOT mark native RECONCILED
      return {
        ...result,
        medications: input.medications,
        logs: input.logs,
        mutated: false,
        toAcknowledge: [],
        markedCount: 0,
      };
    }
  }

  let markedCount = 0;
  for (const ack of result.toAcknowledge) {
    try {
      await mark(ack.medicationId, ack.doseId, ack.calendarDate);
      markedCount += 1;
    } catch {
      // Leave FIRED; next run will already_applied if marker exists
    }
  }

  return { ...result, markedCount };
}
