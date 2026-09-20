import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Medication, ConsumptionLog } from '../types';
import { withAutoStockMutationGate } from '../utils/autoDeductionStockGate';
import { reconcileExactBeforeManualMutation } from '../utils/reconcileExactBeforeManualMutation';
import { TOAST_MESSAGES } from '../constants/uiStrings';

/**
 * One-shot per session Exact reconciliation after hydration.
 *
 * Startup does not run day-based stock settlement and does not deduct
 * `dailyDose` from elapsed calendar days. Exact FIRED occurrences are the
 * sole source of timed automatic stock deduction; missed occurrences are
 * recovered through the exact occurrence recovery path, not elapsed-day math.
 *
 * This effect only reconciles durable native FIRED exact events inside the
 * gate (which commits the exact deductions durably) and then mirrors the
 * post-reconciliation durable state into React so the UI reflects it.
 */
export function useStartupAutoDeduction(opts: {
  hydrated: boolean;
  isFirstRun: boolean;
  setMedications: Dispatch<SetStateAction<Medication[]>>;
  setLogs: Dispatch<SetStateAction<ConsumptionLog[]>>;
  setGlobalAutoDeductEnabled: Dispatch<SetStateAction<boolean>>;
  showToast: (message: string) => void;
}): void {
  const {
    hydrated,
    isFirstRun,
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
    showToast,
  } = opts;

  const deductedRef = useRef(false);
  useEffect(() => {
    if (!hydrated || deductedRef.current) return;
    // First-run onboarding: skip startup Exact reconcile until the user
    // completes the Auto-Deduct decision. Do NOT set deductedRef here —
    // that would permanently block the single post-onboarding pass.
    if (isFirstRun) {
      return;
    }
    deductedRef.current = true;

    // Shared gate loads FRESH durable meds/logs — do not use React snapshot.
    // Even when global is off, we still reconcile already-FIRED exact events
    // (disable must not erase durable FIRED stock events).
    void withAutoStockMutationGate(async (fresh) => {
      const pre = await reconcileExactBeforeManualMutation({
        fresh,
        // Valid FIRED events are reconciled regardless of current policy.
        globalAutoDeductEnabled: fresh.globalAutoDeductEnabled !== false,
      });
      // Native read failure OR unresolved Exact durability: do not mutate
      // React state on top of an unresolved exact occurrence. The exact
      // reconciliation itself commits durably on its mutating path; on a
      // durability block / native-list failure it commits nothing.
      if (pre.nativeListFailed || pre.durabilityBlocked) {
        return;
      }
      // Sync Global preference for UI (bulk last-applied state + new-med
      // default). Runtime Auto still follows each medication.autoDeductEnabled.
      const durableGlobalAutoDeductEnabled = pre.state.globalAutoDeductEnabled !== false;
      setGlobalAutoDeductEnabled(durableGlobalAutoDeductEnabled);
      // Mirror the post-Exact durable state into React. The exact
      // reconciliation already committed meds/logs durably on its mutating
      // path; React only needs the reflected snapshot. No day-based
      // settlement runs on top — Exact FIRED is the sole timed deduction.
      const nextMeds = pre.state.medications;
      const nextLogs = pre.state.logs;
      setMedications(nextMeds);
      setLogs(nextLogs);
      const recon = pre.reconciliation;
      if (recon && recon.newExactLogs.length > 0) {
        const totalPills = recon.newExactLogs.reduce(
          (sum, log) => sum + Math.abs(log.amount),
          0
        );
        if (totalPills > 0) {
          showToast(TOAST_MESSAGES.autoDeductSummary(totalPills));
        }
      }
    });
    // Re-run when isFirstRun transitions true→false after onboarding.
    // deductedRef ensures the reconcile body still runs at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, isFirstRun]);
}
