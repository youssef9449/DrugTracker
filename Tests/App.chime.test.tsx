import { __setExactAutoEnvelopeTestHooks } from '../utils/autoStockTestHooks';
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




import { seedTestMedication as seedMed } from './fixtures/testFixtures';



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


describe('Success chime on toggle actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

): void {
    localStorage.setItem(
      'android_med_tracker_items_v2',
      JSON.stringify([
        {
          id: 'med-chime',
          name: 'Chime Med',
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
  }

  it('Medication Auto-Deduct ON→OFF plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed({ autoDeductEnabled: true });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Medication Auto-Deduct OFF→ON plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed({ autoDeductEnabled: false });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Global Auto-Deduct ON→OFF plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_auto_deduct_v1', 'true');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    // Global toggle is labeled for all meds
    const globalToggle = screen.getByLabelText(/تبديل الخصم التلقائي لجميع الأدوية/);
    fireEvent.click(globalToggle);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Global Auto-Deduct OFF→ON plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed({ autoDeductEnabled: false });
    localStorage.setItem('android_med_tracker_auto_deduct_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const globalToggle = screen.getByLabelText(/تبديل الخصم التلقائي لجميع الأدوية/);
    fireEvent.click(globalToggle);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Display toggle OFF shows "العرض الطبيعي"; ON shows "العرض المختصر" (no شبكة)', async () => {
    seedMed();
    localStorage.setItem('android_med_tracker_compact_view_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    expect(screen.getByText('العرض الطبيعي')).toBeInTheDocument();
    expect(screen.queryByText(/شبكة/)).toBeNull();
    const displayToggle = screen.getByLabelText(/تبديل العرض بين المختصر والعرض الطبيعي/);
    fireEvent.click(displayToggle);
    await waitFor(() => {
      expect(screen.getByText('العرض المختصر')).toBeInTheDocument();
    });
    expect(screen.queryByText(/شبكة/)).toBeNull();
    // Toggle back to OFF
    fireEvent.click(displayToggle);
    await waitFor(() => {
      expect(screen.getByText('العرض الطبيعي')).toBeInTheDocument();
    });
  });

  it('Display (compact view) OFF→ON plays success chime once and toast "تم تفعيل العرض المختصر"', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_compact_view_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const displayToggle = screen.getByLabelText(/تبديل العرض بين المختصر والعرض الطبيعي/);
    fireEvent.click(displayToggle);
    expect(playSuccessChime).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('تم تفعيل العرض المختصر')).toBeInTheDocument();
    });
    expect(screen.queryByText(/شبكة/)).toBeNull();
  });

  it('Display (compact view) ON→OFF plays success chime once and toast "تم إرجاع العرض الطبيعي"', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_compact_view_v1', 'true');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const displayToggle = screen.getByLabelText(/تبديل العرض بين المختصر والعرض الطبيعي/);
    fireEvent.click(displayToggle);
    expect(playSuccessChime).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('تم إرجاع العرض الطبيعي')).toBeInTheDocument();
    });
    expect(screen.queryByText(/شبكة/)).toBeNull();
  });

  it('soundEnabled === false → no sound call on Medication Auto-Deduct toggle', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_sound_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    expect(playSuccessChime).not.toHaveBeenCalled();
  });

  it('Medication Auto-Deduct toggle does not produce duplicate sound', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    // Allow any re-renders
    await waitFor(() => {});
    expect(playSuccessChime).toHaveBeenCalledTimes(1);
  });
});
