/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import App from '@/App';

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
  openExactAlarmSettings: vi.fn(() => Promise.resolve(true)),
  scheduleCriticalAlarm: vi.fn(() => Promise.resolve()),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve()),
  verifyCriticalAlarmPending: vi.fn(() => Promise.resolve(false)),
  criticalAlarmId: vi.fn((id: string) => id.length),
  scheduleDoseReminder: vi.fn(() => Promise.resolve()),
  cancelDoseReminder: vi.fn(() => Promise.resolve()),
  cancelSnoozedDoseReminder: vi.fn(() => Promise.resolve()),
  scheduleSnoozedDoseReminder: vi.fn(() => Promise.resolve()),
  isDoseReminderTimeStillAhead: vi.fn(() => true),
  LEGACY_DOSE_ID: 'legacy',
}));

vi.mock('@/utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

describe('Auto-Deduction First Run Prompt Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows auto-deduct prompt modal on first run (empty localStorage)', async () => {
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

    expect(localStorage.getItem('android_med_tracker_auto_deduct_prompted_v1')).toBe('true');
    expect(localStorage.getItem('android_med_tracker_auto_deduct_v1')).toBe('true');
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

    expect(localStorage.getItem('android_med_tracker_auto_deduct_prompted_v1')).toBe('true');
    expect(localStorage.getItem('android_med_tracker_auto_deduct_v1')).toBe('false');
  });

  it('does not show prompt again once already prompted', async () => {
    localStorage.setItem('android_med_tracker_auto_deduct_prompted_v1', 'true');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('لا توجد أدوية مسجلة حالياً')).toBeInTheDocument();
    });

    expect(screen.queryByText('تفعيل الخصم التلقائي للأدوية؟')).not.toBeInTheDocument();
  });
});
