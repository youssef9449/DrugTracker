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

  it('renders notification toggles as MD3 switches with the same logic and styling as AppHeader', () => {
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

    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات مفعلة — انقر للإيقاف',
    });
    expect(notifSwitch).toBeInTheDocument();
    expect(notifSwitch).toHaveAttribute('aria-checked', 'true');

    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيه النفاذ الحرج مفعّل',
    });
    expect(criticalSwitch).toBeInTheDocument();
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(notifSwitch);
    expect(onToggleNotifications).toHaveBeenCalledTimes(1);

    fireEvent.click(criticalSwitch);
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

    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    expect(notifSwitch).toBeInTheDocument();
    expect(notifSwitch).toHaveAttribute('aria-checked', 'false');

    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيه النفاذ الحرج متوقف',
    });
    expect(criticalSwitch).toBeInTheDocument();
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'false');
  });
});
