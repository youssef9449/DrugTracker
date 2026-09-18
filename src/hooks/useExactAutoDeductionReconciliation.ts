/**
 * Phase 3 — reconcile native FIRED events after hydrate/resume.
 * Does NOT pass React snapshots into the mutation gate; the orchestrator
 * loads durable state inside withAutoStockMutationGate.
 */

import { useEffect, useRef } from 'react';
import type { ConsumptionLog, Medication } from '../types';
import { runAutoDeductionReconciliation } from '../utils/runAutoDeductionReconciliation';
import { loadDurableGlobalAutoDeductEnabled } from '../utils/autoDeductionStockGate';

export interface UseExactAutoDeductionReconciliationOptions {
  setMedications: (meds: Medication[] | ((prev: Medication[]) => Medication[])) => void;
  setLogs: (logs: ConsumptionLog[] | ((prev: ConsumptionLog[]) => ConsumptionLog[])) => void;
  /** Optional UI convergence hook for the durable global master switch. */
  setGlobalAutoDeductEnabled?: (enabled: boolean) => void;
  globalAutoDeductEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  resumeTick?: number;
}

export function useExactAutoDeductionReconciliation({
  setMedications,
  setLogs,
  setGlobalAutoDeductEnabled,
  globalAutoDeductEnabled,
  hydrated,
  isFirstRun,
  resumeTick = 0,
}: UseExactAutoDeductionReconciliationOptions): void {
  const globalRef = useRef(globalAutoDeductEnabled);
  globalRef.current = globalAutoDeductEnabled;

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    let cancelled = false;

    void (async () => {
      const result = await runAutoDeductionReconciliation({
        globalAutoDeductEnabled: globalRef.current,
      });
      if (cancelled) return;
      // React follows durable committed state (not the pre-gate snapshot).
      // The global master switch is stored in the same durable stock domain,
      // so sync it after recovery as well; this prevents a recovered global
      // toggle from remaining stale in React until a full app restart.
      if (result.mutated || result.recoveredEnvelope) {
        setMedications(result.medications);
        setLogs(result.logs);
      }
      if (setGlobalAutoDeductEnabled) {
        setGlobalAutoDeductEnabled(loadDurableGlobalAutoDeductEnabled());
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, isFirstRun, resumeTick, setMedications, setLogs, setGlobalAutoDeductEnabled]);
}
