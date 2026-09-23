/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import App from '@/App';
import { initNativeBridge, registerBackButtonHandler } from '@/native';
import * as manualStockMutation from '@/utils/manualStockMutation';

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
  scheduleDoseReminder: vi.fn(() => Promise.resolve()),
  cancelDoseReminder: vi.fn(() => Promise.resolve()),
  cancelSnoozedDoseReminder: vi.fn(() => Promise.resolve()),
  scheduleSnoozedDoseReminder: vi.fn(() => Promise.resolve()),
  isDoseReminderTimeStillAhead: vi.fn(() => true),
}));

vi.mock('@/utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

const PROMPTED_KEY = 'android_med_tracker_auto_deduct_prompted_v1';
const GLOBAL_KEY = 'android_med_tracker_auto_deduct_v1';

describe('Auto-Deduction First Run Prompt Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(initNativeBridge).mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    cleanup();
  });

  it('does not show first-run prompt until hydration completes', async () => {
    let resolveBridge!: () => void;
    const bridgePending = new Promise<void>((r) => {
      resolveBridge = r;
    });
    vi.mocked(initNativeBridge).mockImplementation(() => bridgePending);

    render(<App />);

    // While native bridge is still pending, hydrated stays false → no prompt.
    expect(
      screen.queryByText('تفعيل الخصم التلقائي للأدوية؟')
    ).not.toBeInTheDocument();

    resolveBridge();

    await waitFor(() => {
      expect(
        screen.getByText('تفعيل الخصم التلقائي للأدوية؟')
      ).toBeInTheDocument();
    });
  });

  it('shows auto-deduct prompt modal on first run (empty localStorage) after hydration', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    });

    expect(screen.getByText('ماذا تفعل هذه الميزة؟')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /نعم \(تفعيل\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /لا \(إيقاف\)/ })).toBeInTheDocument();
  });

  it('enables auto-deduct and closes modal when user chooses "نعم"', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    });

    const yesBtn = screen.getByRole('button', { name: /نعم \(تفعيل\)/ });
    fireEvent.click(yesBtn);

    await waitFor(() => {
      expect(screen.queryByText('تفعيل الخصم التلقائي للأدوية؟')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem(PROMPTED_KEY)).toBe('true');
    expect(localStorage.getItem(GLOBAL_KEY)).toBe('true');
  });

  it('disables auto-deduct and closes modal when user chooses "لا"', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    });

    const noBtn = screen.getByRole('button', { name: /لا \(إيقاف\)/ });
    fireEvent.click(noBtn);

    await waitFor(() => {
      expect(screen.queryByText('تفعيل الخصم التلقائي للأدوية؟')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem(PROMPTED_KEY)).toBe('true');
    expect(localStorage.getItem(GLOBAL_KEY)).toBe('false');
  });

  it('keeps prompt open and does not mark prompted when durable toggle fails', async () => {
    const spy = vi
      .spyOn(manualStockMutation, 'runGatedGlobalAutoDeductToggle')
      .mockResolvedValue({
        outcome: 'persist_failed',
        enable: true,
        medications: [],
        logs: [],
      } as never);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /نعم \(تفعيل\)/ }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    expect(localStorage.getItem(PROMPTED_KEY)).toBeNull();
    spy.mockRestore();
  });

  it('Android Back uses the same OFF decision path as choosing "لا"', async () => {
    let backHandler: (() => boolean) | null = null;
    vi.mocked(registerBackButtonHandler).mockImplementation((fn: (() => boolean) | null) => {
      backHandler = fn;
      return () => {};
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    });

    expect(backHandler).not.toBeNull();
    const consumed = backHandler!();
    expect(consumed).toBe(true);

    await waitFor(() => {
      expect(screen.queryByText('تفعيل الخصم التلقائي للأدوية؟')).not.toBeInTheDocument();
    });

    expect(localStorage.getItem(PROMPTED_KEY)).toBe('true');
    expect(localStorage.getItem(GLOBAL_KEY)).toBe('false');
  });

  it('Android Back failure leaves prompt open and prompted unset', async () => {
    let backHandler: (() => boolean) | null = null;
    vi.mocked(registerBackButtonHandler).mockImplementation((fn: (() => boolean) | null) => {
      backHandler = fn;
      return () => {};
    });

    const spy = vi
      .spyOn(manualStockMutation, 'runGatedGlobalAutoDeductToggle')
      .mockResolvedValue({
        outcome: 'persist_failed',
        enable: false,
        medications: [],
        logs: [],
      } as never);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    });

    backHandler!();

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    expect(screen.getByText('تفعيل الخصم التلقائي للأدوية؟')).toBeInTheDocument();
    expect(localStorage.getItem(PROMPTED_KEY)).toBeNull();
    spy.mockRestore();
  });

  it('does not show prompt again once already prompted', async () => {
    localStorage.setItem(PROMPTED_KEY, 'true');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('لا توجد أدوية مسجلة حالياً')).toBeInTheDocument();
    });

    expect(screen.queryByText('تفعيل الخصم التلقائي للأدوية؟')).not.toBeInTheDocument();
  });
});
