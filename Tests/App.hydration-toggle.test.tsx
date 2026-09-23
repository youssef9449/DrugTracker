import { __setStockMutationOrderingTestHooks, __setManualEnvelopeTestHooks, __setAutoStockGateTestHooks, __setExactAutoEnvelopeTestHooks } from '../utils/autoStockTestHooks';
/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// Mock the modules that touch browser/Capacitor APIs before importing App.
vi.mock('@/native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
  openAppSettings: vi.fn(() => Promise.resolve(false)),
  registerBackButtonHandler: vi.fn(),
  registerNotificationActionHandler: vi.fn(),
  registerDoseReceivedHandler: vi.fn(),
  registerAppResumeHandler: vi.fn(),
  cleanupNativeListeners: vi.fn(),
}));
vi.mock('@/utils/notifications', () => ({
  requestNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendMedicineAlert: vi.fn(),
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
  sendTestAlertNotification: vi.fn(() => Promise.resolve()),
  openNotificationSettings: vi.fn(),
  getNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  getExactAlarmPermission: vi.fn(() => Promise.resolve('granted')),
  openExactAlarmSettings: vi.fn(() => Promise.resolve({ ok: true })),
  scheduleCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  verifyCriticalAlarmPending: vi.fn(() => Promise.resolve({ ok: true, pending: false })),
  criticalAlarmId: vi.fn((id: string) => id.length),

}));
vi.mock('@/utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

// Phase 4: the gated stock mutations use the reconciliation result as the
// fresh durable state inside the critical section (reconcileExact-
// BeforeLegacySettlement). The mock must therefore honor the REAL identity
// contract for a reconciliation with no FIRED events: echo the input
// medications/logs unchanged (no FIRED events → no mutation). Returning
// empty arrays would wipe the durable state inside the gate and turn every
// gated mutation into missing_med.
vi.mock('@/utils/runAutoDeductionReconciliation', () => ({
  runAutoDeductionReconciliation: vi.fn(
    async (opts?: { medications?: unknown[]; logs?: unknown[] }) => ({
      medications: [...(opts?.medications ?? [])],
      logs: [...(opts?.logs ?? [])],
      toAcknowledge: [],
      details: [],
      mutated: false,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    })
  ),
  __setExactAutoEnvelopeTestHooks: vi.fn(),
}));

import App from '@/App';

import { runAutoDeductionReconciliation } from '@/utils/runAutoDeductionReconciliation';

import { getInitialMedications } from './fixtures/initialData';
import { seedTestMedication as seedMed, readDurableMedication as getDurableMed, readDurableLogs as getDurableLogs } from './fixtures/testFixtures';

import { initNativeBridge } from '@/native';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';

// Wave 13 #123: pin system time so the many `new Date().toISOString()`
// known date (2024-09-10T12:00:00Z). Prevents midnight-UTC flake risk
// where the test process's wall-clock date rolls over mid-run. Only
// the Date object is faked so React/testing-library's setTimeout-based
// waitFor polling keeps working unchanged.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});


describe('App — hydration (#15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('loads an empty medications array from localStorage (does not fall back to seed)', async () => {
    // Persist an empty array — the user deleted all medications.
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([]));

    render(<App />);

    // Wait for hydration to complete (permission checks resolve,
    // hydrated flips true). The EmptyState component renders when
    // medications is empty — it shows "لا توجد أدوية مسجلة حالياً".
    await waitFor(() => {
      expect(screen.getByText('لا توجد أدوية مسجلة حالياً')).toBeInTheDocument();
    });

    // The seed medications must NOT have appeared (the old bug kept the
    // seed meds because `parsed.length > 0` was false).
    for (const seedMed of getInitialMedications()) {
      expect(screen.queryByText(seedMed.name)).toBeNull();
    }
  });

  it('loads saved medications from localStorage (non-empty)', async () => {
    const savedMed = {
      id: 'med-custom',
      name: 'Custom Test Med',
      currentPills: 5,
      dailyDose: 1,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      reminderEnabled: false,
    };
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([savedMed]));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Custom Test Med')).toBeInTheDocument();
    });
  });

  it('does not hydrate until initNativeBridge completes (ordering race guard)', async () => {
    // Regression: permissions must not set hydrated=true while initNativeBridge
    // is still in flight (scheduler / exact-reconcile effects are hydration-gated).
    // EmptyState is NOT a hydration marker — it renders whenever medications is [].
    // Observe a real hydration-gated side effect: Phase 3 reconciliation runner.
    let resolveBridge!: () => void;
    const bridgePending = new Promise<void>((resolve) => {
      resolveBridge = resolve;
    });
    vi.mocked(initNativeBridge).mockReturnValueOnce(bridgePending);
    vi.mocked(runAutoDeductionReconciliation).mockClear();

    // Explicit empty inventory (not first-run null key) so isFirstRun=false and
    // hydration-gated auto effects are eligible once hydrated flips true.
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([]));
    render(<App />);

    // Permissions / exact-alarm mocks resolve; bridge still pending → hydrated false
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runAutoDeductionReconciliation).not.toHaveBeenCalled();

    resolveBridge();
    await waitFor(() => {
      expect(runAutoDeductionReconciliation).toHaveBeenCalled();
    });
  });
});

describe('handleToggleAutoDeduct logic (#27)', () => {
  it('undefined → false (turns OFF the default-true)', () => {
    const m = { autoDeductEnabled: undefined };
    const newState = m.autoDeductEnabled === false;
    expect(newState).toBe(false);
  });

  it('true → false (turns OFF)', () => {
    const m = { autoDeductEnabled: true };
    const newState = m.autoDeductEnabled === false;
    expect(newState).toBe(false);
  });

  it('false → true (turns ON)', () => {
    const m = { autoDeductEnabled: false };
    const newState = m.autoDeductEnabled === false;
    expect(newState).toBe(true);
  });
});

describe('handleToggleAutoDeduct — pure updater, no duplicate side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** Click the MedicationMenu auto-deduct icon button (no dropdown). */
  function clickToggleFor(): void {
    // Phase 4 menu redesign: toggle is a direct icon button, not a
    // "خيارات" dropdown item. aria-label switches with state:
    //   - auto active → "إيقاف الخصم التلقائي"
    //   - auto paused → "تفعيل الخصم التلقائي"
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
  }

  /** Seed a single med in localStorage so App renders one MedicationCard. */
): void {
    localStorage.setItem(
      'android_med_tracker_items_v2',
      JSON.stringify([
        {
          id: 'med-toggle',
          name: 'Toggle Med',
          currentPills: 60,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          autoDeductEnabled: true,
          reminderEnabled: false,
          ...overrides,
        },
      ])
    );
    // Ensure no pre-existing logs.
    localStorage.setItem('android_med_tracker_logs_v2', JSON.stringify([]));
  }

  /** Read the durable med from localStorage after a mutation. */


  /** Read the durable logs from localStorage after a mutation. */


  it('Test A — ON → OFF: changes autoDeductEnabled only; currentPills unchanged; no exact_auto log', async () => {
    seedMed({ autoDeductEnabled: true });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // Await the async durable stock gate (Phase 4).
    await waitFor(() => {
      const med = getDurableMed();
      expect(med?.autoDeductEnabled).toBe(false);
    });

    // Issue #267: the toggle changes ONLY autoDeductEnabled.
    const med = getDurableMed();
    expect(med?.autoDeductEnabled).toBe(false);
    expect(med?.currentPills).toBe(60);

    // No exact_auto settlement log created by the toggle.
    const logs = getDurableLogs();
    expect(logs.filter((l) => l.type === 'exact_auto')).toHaveLength(0);
  });

  it('Test B — StrictMode ON → OFF: durable mutation executes exactly once', async () => {
    // StrictMode double-invokes updater functions in development.
    // The Phase 4 gated handler runs the mutation outside the updater,
    // so the durable mutation executes exactly once even under StrictMode.
    //
    // This test instruments the durable commit path (commitDurableAutoStockState
    // via __setAutoStockGateTestHooks) to count how many times the toggle's
    // medication-state mutation is physically committed to durable storage.
    // This counts the actual durable mutation/commit operation — NOT a UI
    // callback, React render, or click handler invocation. If StrictMode
    // caused the gated mutation to execute twice, the counter would be 2.
    seedMed({ autoDeductEnabled: true });

    // Capture the pre-toggle durable medication state.
    const preToggleMed = getDurableMed();
    expect(preToggleMed?.autoDeductEnabled).toBe(true);
    const preToggleCurrentPills = preToggleMed?.currentPills as number;

    // Instrument the durable stock gate to count commits where the
    // autoDeductEnabled flag for med-toggle changed. This is the actual
    // durable mutation commit — the physical write of medications to
    // durable storage, called by commitWithManualEnvelope inside the
    // gated handler. It is NOT a UI callback or React render.
    let toggleCommitCount = 0;
    const { __setAutoStockGateTestHooks } = await import('../utils/autoStockTestHooks');
    const { __setManualEnvelopeTestHooks } = await import('../utils/autoStockTestHooks');
    const { __setExactAutoEnvelopeTestHooks } = await import('../utils/autoStockTestHooks');
    const { __setStockMutationOrderingTestHooks } = await import('../utils/autoStockTestHooks');

    // Install gate hooks: load from real localStorage, commit to real
    // localStorage (so the app reads the updated state), but also count
    // commits where autoDeductEnabled changed for med-toggle.
    __setAutoStockGateTestHooks({
      load: () => ({
        medications: JSON.parse(localStorage.getItem('android_med_tracker_items_v2') ?? '[]'),
        logs: JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') ?? '[]'),
        globalAutoDeductEnabled: true,
      }),
      commit: (state) => {
        // Write to real localStorage (production behavior).
        localStorage.setItem('android_med_tracker_items_v2', JSON.stringify(state.medications));
        localStorage.setItem('android_med_tracker_logs_v2', JSON.stringify(state.logs));
        // Count commits where med-toggle's autoDeductEnabled changed.
        const committedMed = state.medications.find((m) => m.id === 'med-toggle');
        if (committedMed && committedMed.autoDeductEnabled !== preToggleMed?.autoDeductEnabled) {
          toggleCommitCount++;
        }
        return null;
      },
    });
    __setManualEnvelopeTestHooks({ load: () => null, save: () => null });
    __setExactAutoEnvelopeTestHooks({ load: () => null, save: () => null });
    __setStockMutationOrderingTestHooks({
      loadLastApplied: () => 0,
      persistLastApplied: () => null,
      allocate: () => ({ ok: true as const, seq: 1 }),
    });

    const { StrictMode } = await import('react');
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // Exactly ONE durable mutation commit — autoDeductEnabled changed
    // from true to false. This assertion would FAIL if the same ON→OFF
    // user action caused two durable mutation commits (toggleCommitCount
    // would be 2).
    await waitFor(() => {
      expect(toggleCommitCount).toBe(1);
    });

    // Verify the durable state: autoDeductEnabled = false.
    const med = getDurableMed();
    expect(med?.autoDeductEnabled).toBe(false);

    // Issue #267: currentPills unchanged from pre-toggle value.
    expect(med?.currentPills).toBe(preToggleCurrentPills);


    // No exact_auto settlement log created by the toggle.
    const logs = getDurableLogs();
    expect(logs.filter((l) => l.type === 'exact_auto')).toHaveLength(0);

    // Cleanup test hooks.
    __setAutoStockGateTestHooks(null);
    __setManualEnvelopeTestHooks(null);
    __setExactAutoEnvelopeTestHooks(null);
    __setStockMutationOrderingTestHooks(null);
  });

  it('Test C — OFF → ON: changes autoDeductEnabled to true; currentPills unchanged; no exact_auto log', async () => {
    seedMed({ autoDeductEnabled: false });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // Await the async durable stock gate (Phase 4).
    await waitFor(() => {
      const med = getDurableMed();
      expect(med?.autoDeductEnabled).toBe(true);
    });

    // Issue #267: the toggle changes ONLY autoDeductEnabled.
    // No retroactive deduction, no exact_auto log.
    const med = getDurableMed();
    expect(med?.autoDeductEnabled).toBe(true);
    expect(med?.currentPills).toBe(60);

    const logs = getDurableLogs();
    expect(logs.filter((l) => l.type === 'exact_auto')).toHaveLength(0);
  });

  it('one toggle click shows the toast EXACTLY ONCE (no duplicate toasts under StrictMode)', async () => {
    // The toast is also a side effect that was inside the updater in
    // the buggy version. Verify it fires exactly once per click by
    // counting the toast message in the DOM. (Toasts auto-dismiss
    // after 3s, but we check immediately after the click.)
    seedMed();

    const { StrictMode } = await import('react');
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // The toast message for "turn OFF" is "تم إيقاف الخصم التلقائي مؤقتاً لـ ...".
    // It should appear exactly once (not twice — which would happen if
    // showToast were inside the updater under StrictMode).
    await waitFor(() => {
      const toasts = screen.getAllByText(/تم إيقاف الخصم التلقائي مؤقتاً لـ/);
      expect(toasts.length).toBe(1);
    });
  });
});
