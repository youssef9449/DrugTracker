import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Medication, ConsumptionLog } from '../types';
import { getTodayDateString, syncAutoDailyDeductions } from '../utils/dateCalculations';
import { withAutoStockMutationGate, commitDurableAutoStockState } from '../utils/autoDeductionStockGate';
import { TOAST_MESSAGES } from '../constants/uiStrings';

/**
 * One-shot per session auto-deduction after hydration.
 * Same semantics as the previous inline effect in App.tsx.
 */
export function useStartupAutoDeduction(opts: {
  hydrated: boolean;
  isFirstRun: boolean;
  globalAutoDeductEnabled: boolean;
  setMedications: Dispatch<SetStateAction<Medication[]>>;
  setLogs: Dispatch<SetStateAction<ConsumptionLog[]>>;
  showToast: (message: string) => void;
}): void {
  const {
    hydrated,
    isFirstRun,
    globalAutoDeductEnabled,
    setMedications,
    setLogs,
    showToast,
  } = opts;

  const deductedRef = useRef(false);
  useEffect(() => {
    if (!hydrated || deductedRef.current) return;
    // First-run: don't auto-deduct or fire notifications for seed data.
    if (isFirstRun) {
      deductedRef.current = true;
      return;
    }
    deductedRef.current = true;

    if (!globalAutoDeductEnabled) {
      return;
    }

    // Shared gate loads FRESH durable meds/logs — do not use React snapshot.
    void withAutoStockMutationGate((fresh) => {
      const today = getTodayDateString();
      const result = syncAutoDailyDeductions(fresh.medications, today);
      if (result.newLogs.length > 0) {
        const nextLogs = [...result.newLogs, ...fresh.logs];
        const err = commitDurableAutoStockState({
          medications: result.updatedMeds,
          logs: nextLogs,
        });
        if (!err) {
          setMedications(result.updatedMeds);
          setLogs(nextLogs);
          const totalPills = result.deductedSummary.reduce((sum, item) => sum + item.pillsDeducted, 0);
          showToast(TOAST_MESSAGES.autoDeductSummary(totalPills));
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);
}
