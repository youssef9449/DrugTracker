/**
 * Phase 3/4 — reconcile native FIRED events after hydrate/resume and immediately
 * when the native exact-alarm receiver reports a newly durable FIRED event.
 *
 * The native EventStore remains the source of truth. The event listener is only
 * a wake-up signal; reconciliation always re-reads durable native + JS state
 * through runAutoDeductionReconciliation.
 *
 * There is deliberately NO polling timer here. If an event arrives while a
 * reconciliation is already running, the event is coalesced into one follow-up
 * reconciliation after the current one finishes. Hydration, every app resume,
 * and the local-midnight rollover while the app stays open (midnightTick) each
 * perform one recovery reconciliation.
 */

import { useEffect, useRef } from 'react';
import type { ConsumptionLog, Medication } from '../types';
import { runAutoDeductionReconciliation } from '../utils/runAutoDeductionReconciliation';
import { loadDurableGlobalAutoDeductEnabled } from '../utils/autoDeductionStockGate';
import {
  addExactAutoDeductionFiredListener,
} from '../utils/autoDeductionNative';
import {
  recoveryBoundaryKey,
  restoreFutureSchedulesOnce,
} from '../utils/restoreFutureSchedulesBoundary';

export interface UseExactAutoDeductionReconciliationOptions {
  setMedications: (meds: Medication[] | ((prev: Medication[]) => Medication[])) => void;
  setLogs: (logs: ConsumptionLog[] | ((prev: ConsumptionLog[]) => ConsumptionLog[])) => void;
  /** Optional UI convergence hook for the durable global master switch. */
  setGlobalAutoDeductEnabled?: (enabled: boolean) => void;
  globalAutoDeductEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  resumeTick?: number;
  /** Increments at each local-midnight rollover while the app stays open. */
  midnightTick?: number;
}

export function useExactAutoDeductionReconciliation({
  setMedications,
  setLogs,
  setGlobalAutoDeductEnabled,
  globalAutoDeductEnabled,
  hydrated,
  isFirstRun,
  resumeTick = 0,
  midnightTick = 0,
}: UseExactAutoDeductionReconciliationOptions): void {
  const globalRef = useRef(globalAutoDeductEnabled);
  const reconciliationRunningRef = useRef(false);
  const reconciliationQueuedRef = useRef(false);

  globalRef.current = globalAutoDeductEnabled;

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    let cancelled = false;

    const reconcile = async (recoverNativeSchedules = false): Promise<void> => {
      if (cancelled) return;

      if (reconciliationRunningRef.current) {
        reconciliationQueuedRef.current = true;
        return;
      }

      reconciliationRunningRef.current = true;

      try {
        if (recoverNativeSchedules) {
          // Recovery boundary: one native future-schedule + independent-evidence
          // restore per boundary key (shared with useAutoDeductionScheduler).
          // Failure makes this boundary retryable and is NOT success-cached.
          // That is independent of the FIRED ledger: EventStore rows remain the
          // stock source of truth and may still be reconciled below even when
          // native schedule recovery is incomplete. This does not ignore restore
          // failure — only separates schedule recovery from FIRED reconciliation.
          // Not polling: hydrate/resume/midnight triggers only.
          const restoreResult = await restoreFutureSchedulesOnce(
            recoveryBoundaryKey(resumeTick, midnightTick)
          );
          if (cancelled) return;
          if (!restoreResult.ok) {
            console.warn(
              '[App] Exact Auto native schedule restore failed (boundary retryable):',
              restoreResult.error || 'restore_failed'
            );
          }
        }

        const result = await runAutoDeductionReconciliation({
          globalAutoDeductEnabled: globalRef.current,
        });
        if (cancelled) return;

        // React follows durable committed state (not the pre-gate snapshot).
        // The global master switch is stored in the same durable stock domain,
        // so sync it after recovery as well; this prevents a recovered global
        // toggle from remaining stale in React until another app event.
        if (result.mutated || result.recoveredEnvelope) {
          setMedications(result.medications);
          setLogs(result.logs);
        }
        if (setGlobalAutoDeductEnabled) {
          setGlobalAutoDeductEnabled(loadDurableGlobalAutoDeductEnabled());
        }
      } catch (err) {
        // The durable native FIRED event remains the source of truth. A failed
        // event-driven reconciliation is recovered by the next app event,
        // including a subsequent FIRED event or app resume/startup.
        console.warn('[App] Exact Auto event-driven reconciliation failed:', err);
      } finally {
        reconciliationRunningRef.current = false;

        if (!cancelled && reconciliationQueuedRef.current) {
          reconciliationQueuedRef.current = false;
          void reconcile();
        }
      }
    };

    let listenerHandle: { remove: () => Promise<void> } | null = null;
    let listenerCancelled = false;

    // Register the native wake-up before the recovery reconciliation. If an
    // alarm fires during listener setup, the durable FIRED row is still picked
    // up by this one-shot recovery once registration completes.
    void addExactAutoDeductionFiredListener(() => {
      if (listenerCancelled || cancelled) return;
      // Native already persisted FIRED before emitting this wake-up signal.
      void reconcile(false);
    }).then((handle) => {
      if (listenerCancelled || cancelled) {
        void handle?.remove();
        return;
      }
      listenerHandle = handle;

      // Recovery boundary: hydrate and every app resume perform one
      // reconciliation after the event listener is armed. This is NOT polling;
      // it covers events that occurred while JS was unavailable or during setup.
      void reconcile(true);
    }).catch((err) => {
      console.warn('[App] Exact Auto event listener registration failed:', err);
      // Even if the listener cannot be attached, perform the recovery read once.
      void reconcile(true);
    });

    return () => {
      cancelled = true;
      listenerCancelled = true;
      reconciliationQueuedRef.current = false;
      if (listenerHandle) {
        void listenerHandle.remove();
        listenerHandle = null;
      }
    };
  }, [
    hydrated,
    isFirstRun,
    resumeTick,
    midnightTick,
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
  ]);
}
