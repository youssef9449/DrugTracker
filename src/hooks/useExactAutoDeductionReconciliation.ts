/**
 * Phase 3 — reconcile native FIRED events after hydrate/resume.
 * Does NOT pass React snapshots into the mutation gate; the orchestrator
 * loads durable state inside withAutoStockMutationGate.
 */

import { useEffect, useRef } from 'react';
import type { ConsumptionLog, Medication } from '../types';
import { runAutoDeductionReconciliation } from '../utils/runAutoDeductionReconciliation';
import { loadDurableGlobalAutoDeductEnabled } from '../utils/autoDeductionStockGate';
import { isAppInForeground } from '../utils/notifications';

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const reconcileOnceAndSchedule = async (): Promise<void> => {
      if (cancelled || !isAppInForeground()) return;

      try {
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
      } catch (err) {
        // Keep the foreground loop retryable. The durable native FIRED event
        // remains the source of truth when JS reconciliation is temporarily
        // unavailable.
        console.warn('[App] Exact Auto foreground reconciliation failed:', err);
      }

      if (!cancelled && isAppInForeground()) {
        retryTimer = setTimeout(
          () => void reconcileOnceAndSchedule(),
          10_000
        );
      }
    };

    void reconcileOnceAndSchedule();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
  }, [hydrated, isFirstRun, resumeTick, setMedications, setLogs, setGlobalAutoDeductEnabled]);
}
