/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { PharmacySettings } from '@/types';

const mockSettings: PharmacySettings = {
  pharmacyPhone: '01000000000',
  pharmacyName: 'صيدلية الأمل',
  customerCode: '12345',
  defaultDurationDays: 30,
  customQuantities: {},
  address: 'شارع التحرير',
  contactPhone: '01100000000',
};

describe('AppSettingsModal — Notification Controls', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('renders notification toggles as action buttons with the same logic and styling as AppHeader', () => {
    const onToggleNotifications = vi.fn();
    const onToggleCriticalStockAlerts = vi.fn();

    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        onToggleSound={vi.fn()}
        notificationsEnabled={true}
        onToggleNotifications={onToggleNotifications}
        criticalStockAlertsEnabled={true}
        onToggleCriticalStockAlerts={onToggleCriticalStockAlerts}
      />
    );

    const notifBtn = screen.getByRole('button', {
      name: 'التنبيهات مفعلة — انقر للإيقاف',
    });
    expect(notifBtn).toBeInTheDocument();
    expect(notifBtn).toHaveAttribute('aria-pressed', 'true');

    const criticalBtn = screen.getByRole('button', {
      name: 'تنبيه النفاذ الحرج مفعّل',
    });
    expect(criticalBtn).toBeInTheDocument();
    expect(criticalBtn).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(notifBtn);
    expect(onToggleNotifications).toHaveBeenCalledTimes(1);

    fireEvent.click(criticalBtn);
    expect(onToggleCriticalStockAlerts).toHaveBeenCalledTimes(1);
  });

  it('reflects disabled state titles and labels when toggled off', () => {
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        onToggleSound={vi.fn()}
        notificationsEnabled={false}
        onToggleNotifications={vi.fn()}
        criticalStockAlertsEnabled={false}
        onToggleCriticalStockAlerts={vi.fn()}
      />
    );

    const notifBtn = screen.getByRole('button', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    expect(notifBtn).toBeInTheDocument();
    expect(notifBtn).toHaveAttribute('aria-pressed', 'false');

    const criticalBtn = screen.getByRole('button', {
      name: 'تنبيه النفاذ الحرج متوقف',
    });
    expect(criticalBtn).toBeInTheDocument();
    expect(criticalBtn).toHaveAttribute('aria-pressed', 'false');
  });
});
