/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

  it('renders notification toggles as MD3 switches; clicking flips draft state and Save commits via onApplyAppPreferences', async () => {
    // The modal stores preference toggles as DRAFT state (setDraftNotifications /
    // setDraftCritical) — the deprecated onToggleNotifications /
    // onToggleCriticalStockAlerts callbacks are NOT wired into the modal body.
    // Drafts are committed only on حفظ الإعدادات via onApplyAppPreferences.
    const onApplyAppPreferences = vi.fn();
    const onSaveSettings = vi.fn();

    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={onSaveSettings}
        soundEnabled={true}
        onToggleSound={vi.fn()}
        notificationsEnabled={true}
        onToggleNotifications={vi.fn()}
        criticalStockAlertsEnabled={true}
        onToggleCriticalStockAlerts={vi.fn()}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );

    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات مفعلة — انقر للإيقاف',
    });
    expect(notifSwitch).toBeInTheDocument();
    expect(notifSwitch).toHaveAttribute('aria-checked', 'true');

    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيهات المخزون الحرج مفعلة — انقر للإيقاف',
    });
    expect(criticalSwitch).toBeInTheDocument();
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'true');

    // Clicking each switch flips its draft state (visible immediately as
    // aria-checked flipping true → false). No onToggle* callback fires.
    fireEvent.click(notifSwitch);
    expect(notifSwitch).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(criticalSwitch);
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'false');

    // Saving the form commits the (now-toggled) drafts via onApplyAppPreferences.
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }));
    await waitFor(() => {
      expect(onApplyAppPreferences).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationsEnabled: false,
          criticalStockAlertsEnabled: false,
        })
      );
    });
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
      name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
    });
    expect(criticalSwitch).toBeInTheDocument();
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'false');
  });
});
