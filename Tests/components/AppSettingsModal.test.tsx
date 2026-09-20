/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { PharmacySettings } from '@/types';

import { TOAST_MESSAGES } from '@/constants/uiStrings';

const notifMocks = vi.hoisted(() => ({
  getPermission: vi.fn(),
  requestPermission: vi.fn(),
}));

vi.mock('@/utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/utils/notifications')>(
    '@/utils/notifications'
  );
  return {
    ...actual,
    getNotificationPermission: notifMocks.getPermission,
    requestNotificationPermission: notifMocks.requestPermission,
  };
});

const mockSettings: PharmacySettings = {
  defaultDurationDays: 30,
  pharmacies: [],
  selectedPharmacyId: '',
  whatsappContacts: [],
  whatsappAddresses: [],
  selectedWhatsappContactIds: [],
  selectedWhatsappAddressIds: [],
};

describe('AppSettingsModal — Notification Controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifMocks.getPermission.mockResolvedValue('granted');
    notifMocks.requestPermission.mockResolvedValue(true);
  });
  afterEach(() => cleanup());

  it('renders notification toggles as MD3 switches; clicking flips draft state and Save commits via onApplyAppPreferences', async () => {
    // The modal stores preference toggles as DRAFT state (setDraftNotifications /
    // draft toggles + onApplyAppPreferences are the current preference path.
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
        notificationsEnabled={true}
        criticalStockAlertsEnabled={true}
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
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
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


describe('AppSettingsModal — permission guard on toggle ON', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifMocks.getPermission.mockResolvedValue('granted');
    notifMocks.requestPermission.mockResolvedValue(true);
  });
  afterEach(() => cleanup());

  it('notifications OFF→ON with permission granted becomes ON', async () => {
    notifMocks.getPermission.mockResolvedValue('granted');
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={vi.fn()}
      />
    );
    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    fireEvent.click(notifSwitch);
    await waitFor(() => {
      expect(notifSwitch).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('notifications OFF→ON with permission denied stays OFF and toasts', async () => {
    notifMocks.getPermission.mockResolvedValue('denied');
    const showToast = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={vi.fn()}
        showToast={showToast}
      />
    );
    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    fireEvent.click(notifSwitch);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(TOAST_MESSAGES.notificationsPermissionDenied);
    });
    expect(notifSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('notifications OFF→ON with permission error stays OFF and toasts', async () => {
    notifMocks.getPermission.mockRejectedValue(new Error('boom'));
    const showToast = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={vi.fn()}
        showToast={showToast}
      />
    );
    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    fireEvent.click(notifSwitch);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(TOAST_MESSAGES.notificationsPermissionDenied);
    });
    expect(notifSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('critical OFF→ON with permission granted becomes ON', async () => {
    notifMocks.getPermission.mockResolvedValue('granted');
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={vi.fn()}
      />
    );
    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
    });
    fireEvent.click(criticalSwitch);
    await waitFor(() => {
      expect(criticalSwitch).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('critical OFF→ON with permission denied stays OFF and toasts', async () => {
    notifMocks.getPermission.mockResolvedValue('denied');
    const showToast = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={vi.fn()}
        showToast={showToast}
      />
    );
    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
    });
    fireEvent.click(criticalSwitch);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(TOAST_MESSAGES.notificationsPermissionDenied);
    });
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('critical OFF→ON with permission error stays OFF and toasts', async () => {
    notifMocks.getPermission.mockRejectedValue(new Error('fail'));
    const showToast = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={vi.fn()}
        showToast={showToast}
      />
    );
    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
    });
    fireEvent.click(criticalSwitch);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(TOAST_MESSAGES.notificationsPermissionDenied);
    });
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('permission failure then Save does not commit notificationsEnabled true', async () => {
    notifMocks.getPermission.mockResolvedValue('denied');
    const onApplyAppPreferences = vi.fn();
    const showToast = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={onApplyAppPreferences}
        showToast={showToast}
      />
    );
    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    fireEvent.click(notifSwitch);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalled();
    });
    expect(notifSwitch).toHaveAttribute('aria-checked', 'false');
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
});

describe('AppSettingsModal — draft-only until Save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifMocks.getPermission.mockResolvedValue('granted');
    notifMocks.requestPermission.mockResolvedValue(true);
  });
  afterEach(() => cleanup());



  it('notifications OFF→ON with Save commits true only on Save', async () => {
    const onApplyAppPreferences = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    fireEvent.click(notifSwitch);
    await waitFor(() => {
      expect(notifSwitch).toHaveAttribute('aria-checked', 'true');
    });
    expect(onApplyAppPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }));
    await waitFor(() => {
      expect(onApplyAppPreferences).toHaveBeenCalledTimes(1);
      expect(onApplyAppPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ notificationsEnabled: true })
      );
    });
  });

  it('notifications ON→OFF with Save commits false only on Save', async () => {
    const onApplyAppPreferences = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={true}
        criticalStockAlertsEnabled={true}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات مفعلة — انقر للإيقاف',
    });
    fireEvent.click(notifSwitch);
    expect(notifSwitch).toHaveAttribute('aria-checked', 'false');
    expect(onApplyAppPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }));
    await waitFor(() => {
      expect(onApplyAppPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ notificationsEnabled: false })
      );
    });
  });



  it('critical OFF→ON with Save commits true only on Save', async () => {
    const onApplyAppPreferences = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
    });
    fireEvent.click(criticalSwitch);
    await waitFor(() => {
      expect(criticalSwitch).toHaveAttribute('aria-checked', 'true');
    });
    expect(onApplyAppPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }));
    await waitFor(() => {
      expect(onApplyAppPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ criticalStockAlertsEnabled: true })
      );
    });
  });

  it('critical ON→OFF with Save commits false only on Save', async () => {
    const onApplyAppPreferences = vi.fn();
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={true}
        criticalStockAlertsEnabled={true}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيهات المخزون الحرج مفعلة — انقر للإيقاف',
    });
    fireEvent.click(criticalSwitch);
    expect(criticalSwitch).toHaveAttribute('aria-checked', 'false');
    expect(onApplyAppPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }));
    await waitFor(() => {
      expect(onApplyAppPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ criticalStockAlertsEnabled: false })
      );
    });
  });

  it('toggle then Close without Save discards draft; reopen shows committed values', async () => {
    const onApplyAppPreferences = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <AppSettingsModal
        isOpen={true}
        onClose={onClose}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    const notifSwitch = screen.getByRole('switch', {
      name: 'التنبيهات متوقفة — انقر للتفعيل',
    });
    const criticalSwitch = screen.getByRole('switch', {
      name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
    });
    fireEvent.click(notifSwitch);
    fireEvent.click(criticalSwitch);
    await waitFor(() => {
      expect(notifSwitch).toHaveAttribute('aria-checked', 'true');
      expect(criticalSwitch).toHaveAttribute('aria-checked', 'true');
    });
    expect(onApplyAppPreferences).not.toHaveBeenCalled();

    // Close without Save (parent still false/false).
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(onClose).toHaveBeenCalled();
    expect(onApplyAppPreferences).not.toHaveBeenCalled();

    // Reopen: drafts reset from committed parent props (still false).
    rerender(
      <AppSettingsModal
        isOpen={false}
        onClose={onClose}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    rerender(
      <AppSettingsModal
        isOpen={true}
        onClose={onClose}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'التنبيهات متوقفة — انقر للتفعيل' })
      ).toHaveAttribute('aria-checked', 'false');
      expect(
        screen.getByRole('switch', {
          name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
        })
      ).toHaveAttribute('aria-checked', 'false');
    });
    expect(onApplyAppPreferences).not.toHaveBeenCalled();
  });

  it('Critical ON then Notifications OFF → Save keeps independent finals', async () => {
    const onApplyAppPreferences = vi.fn();
    notifMocks.getPermission.mockResolvedValue('granted');
    render(
      <AppSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={mockSettings}
        medications={[]}
        onSaveSettings={vi.fn()}
        soundEnabled={true}
        notificationsEnabled={false}
        criticalStockAlertsEnabled={false}
        onApplyAppPreferences={onApplyAppPreferences}
      />
    );
    // Critical ON (permission success also enables draftNotifications).
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل',
      })
    );
    await waitFor(() => {
      expect(
        screen.getByRole('switch', {
          name: 'تنبيهات المخزون الحرج مفعلة — انقر للإيقاف',
        })
      ).toHaveAttribute('aria-checked', 'true');
    });
    // User then turns Notifications OFF while Critical stays ON.
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'التنبيهات مفعلة — انقر للإيقاف',
      })
    );
    expect(
      screen.getByRole('switch', {
        name: 'التنبيهات متوقفة — انقر للتفعيل',
      })
    ).toHaveAttribute('aria-checked', 'false');
    expect(onApplyAppPreferences).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }));
    await waitFor(() => {
      expect(onApplyAppPreferences).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationsEnabled: false,
          criticalStockAlertsEnabled: true,
        })
      );
    });
  });

});
