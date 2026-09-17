import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Medication, ConsumptionLog } from '../types';
import { getTodayDateString, syncAutoDailyDeductions } from '../utils/dateCalculations';
import { withAutoStockMutationGate, commitDurableAutoStockState } from '../utils/autoDeductionStockGate';
import { reconcileExactBeforeLegacySettlement } from '../utils/reconcileExactBeforeLegacySettlement';
import { TOAST_MESSAGES } from '../constants/uiStrings';

/**
 * One-shot per session auto-deduction after hydration.
 * Same semantics as the previous inline effect in App.tsx.
 *
 * Ordering invariant: durable native FIRED exact events are reconciled
 * inside the gate BEFORE legacy syncAutoDailyDeductions historical settlement.
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

    // Shared gate loads FRESH durable meds/logs — do not use React snapshot.
    // Even when global is off, we still reconcile already-FIRED exact events
    // (disable must not erase durable FIRED stock events).
    void withAutoStockMutationGate(async (fresh) => {
      const pre = await reconcileExactBeforeLegacySettlement({
        fresh,
        globalAutoDeductEnabled,
      });
      // Native list failure: do not run legacy settlement (retry next session).
      if (pre.nativeListFailed) {
        return;
      }
      if (!globalAutoDeductEnabled) {
        // Exact path may still have mutated stock; surface if so.
        if (pre.reconciliation?.mutated) {
          setMedications(pre.state.medications);
          setLogs(pre.state.logs);
        }
        return;
      }
      const today = getTodayDateString();
      const result = syncAutoDailyDeductions(pre.state.medications, today);
      if (result.newLogs.length > 0 || pre.reconciliation?.mutated) {
        const nextLogs =
          result.newLogs.length > 0
            ? [...result.newLogs, ...pre.state.logs]
            : pre.state.logs;
        const nextMeds = result.newLogs.length > 0 ? result.updatedMeds : pre.state.medications;
        const err = commitDurableAutoStockState({
          medications: nextMeds,
          logs: nextLogs,
        });
        if (!err) {
          setMedications(nextMeds);
          setLogs(nextLogs);
          if (result.deductedSummary.length > 0) {
            const totalPills = result.deductedSummary.reduce(
              (sum, item) => sum + item.pillsDeducted,
              0
            );
            showToast(TOAST_MESSAGES.autoDeductSummary(totalPills));
          }
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);
}
