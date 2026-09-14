/**
 * Phase 3 — run native FIRED event reconciliation on hydrate + resume.
 * Serialized; does not touch notification scheduling.
 */

import { useEffect, useRef } from 'react';
import type { ConsumptionLog, Medication } from '../types';
import { runAutoDeductionReconciliation } from '../utils/runAutoDeductionReconciliation';

export interface UseExactAutoDeductionReconciliationOptions {
  medications: Medication[];
  logs: ConsumptionLog[];
  setMedications: (meds: Medication[] | ((prev: Medication[]) => Medication[])) => void;
  setLogs: (logs: ConsumptionLog[] | ((prev: ConsumptionLog[]) => ConsumptionLog[])) => void;
  globalAutoDeductEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  /** Resume tick from App (same pattern as dose alarm resume). */
  resumeTick?: number;
}

export function useExactAutoDeductionReconciliation({
  medications,
  logs,
  setMedications,
  setLogs,
  globalAutoDeductEnabled,
  hydrated,
  isFirstRun,
  resumeTick = 0,
}: UseExactAutoDeductionReconciliationOptions): void {
  // Keep latest state without re-firing on every med mutation
  const medsRef = useRef(medications);
  const logsRef = useRef(logs);
  medsRef.current = medications;
  logsRef.current = logs;

  const globalRef = useRef(globalAutoDeductEnabled);
  globalRef.current = globalAutoDeductEnabled;

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    let cancelled = false;

    void (async () => {
      const result = await runAutoDeductionReconciliation({
        medications: medsRef.current,
        logs: logsRef.current,
        globalAutoDeductEnabled: globalRef.current,
      });
      if (cancelled) return;
      if (result.mutated) {
        setMedications(result.medications);
        setLogs(result.logs);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, isFirstRun, resumeTick, setMedications, setLogs]);
}
