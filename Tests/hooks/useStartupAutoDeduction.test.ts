/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import type { Medication, ConsumptionLog } from '@/types';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('@/utils/autoDeductionStockGate', () => ({
  withAutoStockMutationGate: (...args: unknown[]) => mocks.gate(...args),
}));

vi.mock('@/utils/reconcileExactBeforeManualMutation', () => ({
  reconcileExactBeforeManualMutation: (...args: unknown[]) =>
    mocks.reconcile(...args),
}));

import { useStartupAutoDeduction } from '@/hooks/useStartupAutoDeduction';

const sampleMeds: Medication[] = [];
const sampleLogs: ConsumptionLog[] = [];

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('useStartupAutoDeduction — first-run lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockImplementation(async (fn: (fresh: unknown) => Promise<unknown>) => {
      const fresh = {
        medications: sampleMeds,
        logs: sampleLogs,
        globalAutoDeductEnabled: true,
      };
      return fn(fresh);
    });
    mocks.reconcile.mockResolvedValue({
      state: {
        medications: sampleMeds,
        logs: sampleLogs,
        globalAutoDeductEnabled: true,
      },
      nativeListFailed: false,
      durabilityBlocked: false,
      reconciliation: { newExactLogs: [] },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('blocks startup reconcile while isFirstRun=true, runs once after true→false, and does not repeat', async () => {
    const setMedications = vi.fn();
    const setLogs = vi.fn();
    const setGlobalAutoDeductEnabled = vi.fn();
    const showToast = vi.fn();

    const { rerender } = renderHook(
      (props: { hydrated: boolean; isFirstRun: boolean }) =>
        useStartupAutoDeduction({
          hydrated: props.hydrated,
          isFirstRun: props.isFirstRun,
          setMedications,
          setLogs,
          setGlobalAutoDeductEnabled,
          showToast,
        }),
      { initialProps: { hydrated: true, isFirstRun: true } }
    );

    await flushMicrotasks();
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();

    // Onboarding completed: isFirstRun clears; startup Exact reconcile may run once.
    rerender({ hydrated: true, isFirstRun: false });
    await waitFor(() => {
      expect(mocks.gate).toHaveBeenCalledTimes(1);
    });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);

    // Later renders with the same flags must not re-run the one-shot effect.
    rerender({ hydrated: true, isFirstRun: false });
    await flushMicrotasks();
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not run startup reconcile on hydration alone while first-run is still active', async () => {
    const setMedications = vi.fn();
    const setLogs = vi.fn();
    const setGlobalAutoDeductEnabled = vi.fn();
    const showToast = vi.fn();

    const { rerender } = renderHook(
      (props: { hydrated: boolean; isFirstRun: boolean }) =>
        useStartupAutoDeduction({
          hydrated: props.hydrated,
          isFirstRun: props.isFirstRun,
          setMedications,
          setLogs,
          setGlobalAutoDeductEnabled,
          showToast,
        }),
      { initialProps: { hydrated: false, isFirstRun: true } }
    );

    await flushMicrotasks();
    expect(mocks.gate).not.toHaveBeenCalled();

    // Hydration completes but onboarding is still open.
    rerender({ hydrated: true, isFirstRun: true });
    await flushMicrotasks();
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();

    // Only after isFirstRun ends does the one-shot startup reconcile run.
    rerender({ hydrated: true, isFirstRun: false });
    await waitFor(() => {
      expect(mocks.gate).toHaveBeenCalledTimes(1);
    });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });
});
