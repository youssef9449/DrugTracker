/**
 * Phase 3 — reconcile native FIRED events after hydrate/resume.
 * Does NOT pass React snapshots into the mutation gate; the orchestrator
 * loads durable state inside withAutoStockMutationGate.
 */

import { useEffect, useRef } from 'react';
import type { ConsumptionLog, Medication } from '../types';
import { runAutoDeductionReconciliation } from '../utils/runAutoDeductionReconciliation';

export interface UseExactAutoDeductionReconciliationOptions {
  setMedications: (meds: Medication[] | ((prev: Medication[]) => Medication[])) => void;
  setLogs: (logs: ConsumptionLog[] | ((prev: ConsumptionLog[]) => ConsumptionLog[])) => void;
  globalAutoDeductEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  resumeTick?: number;
}

export function useExactAutoDeductionReconciliation({
  setMedications,
  setLogs,
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
      // React follows durable committed state (not the pre-gate snapshot)
      if (result.mutated || result.recoveredEnvelope) {
        setMedications(result.medications);
        setLogs(result.logs);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, isFirstRun, resumeTick, setMedications, setLogs]);
}
