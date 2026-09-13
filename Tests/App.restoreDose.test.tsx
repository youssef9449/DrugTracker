/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

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
}));

vi.mock('@/utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

import App from '@/App';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const TEST_DATE = '2024-09-10';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TEST_DATE}T12:00:00Z`));
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/?tab=logs');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App — multi-dose restore handler', () => {
  function seedMed(): void {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        {
          id: 'med-restore-handler',
          name: 'Restore Handler Med',
          currentPills: 10,
          dailyDose: 4,
          unit: 'قرص',
          warningThresholdDays: 3,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSyncDate: TEST_DATE,
          autoDeductEnabled: true,
          reminderEnabled: false,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
            { id: 'd3', amount: 2, time: '20:00' },
          ],
          dosesPerDay: 3,
        },
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, '[]');
  }

  it('blocks a duplicate restore for the same doseId but allows another dose the same day', async () => {
    seedMed();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
      expect(screen.getByText('سجل الاستهلاك')).toBeInTheDocument();
      expect(screen.getByLabelText('اختر الجرعة')).toBeInTheDocument();
    });

    const doseSelect = screen.getByLabelText('اختر الجرعة');
    const restoreButton = screen.getByRole('button', {
      name: /إعادة الجرعة المخصومة للمخزون/,
    });

    // Restore 08:00 (+1).
    fireEvent.change(doseSelect, { target: { value: 'd1' } });
    fireEvent.click(restoreButton);
    await waitFor(() => {
      expect(screen.getByText(/تم استرجاع جرعة \(1 قرص\) إلى مخزون/)).toBeInTheDocument();
    });

    // Same slot again: handleRestoreDose must reject it via the persisted log.
    fireEvent.click(restoreButton);
    await waitFor(() => {
      expect(screen.getByText('تم استرجاع جرعة "Restore Handler Med" اليوم بالفعل.')).toBeInTheDocument();
    });

    // 14:00 is a different logical dose and must still be independently restorable (+1).
    fireEvent.change(doseSelect, { target: { value: 'd2' } });
    fireEvent.click(restoreButton);
    await waitFor(() => {
      const successToasts = screen.getAllByText(/تم استرجاع جرعة \(1 قرص\) إلى مخزون/);
      expect(successToasts.length).toBeGreaterThanOrEqual(1);
    });

    // The two successful restores must be represented by two dose-scoped logs;
    // the duplicate click must not create a third restore log.
    await waitFor(() => {
      const logs = JSON.parse(localStorage.getItem(STORAGE_LOGS_KEY) || '[]');
      const restores = logs.filter((log: { type: string }) => log.type === 'skipped_day');
      expect(restores).toHaveLength(2);
      expect(restores.map((log: { doseId?: string }) => log.doseId).sort()).toEqual(['d1', 'd2']);
    });
  });
});
