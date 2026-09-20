/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AppHeader } from '@/components/AppHeader';
import type { ActiveTab } from '@/components/AndroidBottomNav';

/** The props AppHeader accepts (mirrors AppHeaderProps). */
interface AppHeaderTestProps {
  activeTab: ActiveTab;
  filter: 'all' | 'alerts' | 'sufficient';
  onFilterChange: (filter: 'all' | 'alerts' | 'sufficient') => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  alertsCount: number;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  criticalStockAlertsEnabled: boolean;
  onToggleCriticalStockAlerts: () => void;
  isPhoneFrame: boolean;
  onTogglePhoneFrame: () => void;
  onOpenSettings: () => void;
  fontScale: 'normal' | 'large';
  onToggleFontScale: () => void;
}

function renderHeader(overrides: Partial<AppHeaderTestProps> = {}) {
  const props: AppHeaderTestProps = {
    activeTab: 'stock',
    filter: 'all',
    onFilterChange: vi.fn(),
    searchQuery: '',
    onSearchChange: vi.fn(),
    alertsCount: 0,
    notificationsEnabled: false,
    onToggleNotifications: vi.fn(),
    criticalStockAlertsEnabled: true,
    onToggleCriticalStockAlerts: vi.fn(),
    isPhoneFrame: true,
    onTogglePhoneFrame: vi.fn(),
    onOpenSettings: vi.fn(),
    fontScale: 'normal',
    onToggleFontScale: vi.fn(),
    ...overrides,
  };
  return render(<AppHeader {...props} />);
}

describe('AppHeader — no sound management (moved to settings)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('does not render the sound panel / audio button', () => {
    renderHeader();
    expect(screen.queryByText('تأثيرات صوتية في التطبيق')).toBeNull();
    expect(screen.queryByText('صوت إشعار مخصص (لكل الأدوية)')).toBeNull();
    expect(screen.queryByTitle('إدارة الأصوات')).toBeNull();
  });

  it('renders the settings button', () => {
    renderHeader();
    expect(screen.getByTitle('الإعدادات')).toBeInTheDocument();
  });

  it('renders the font-size toggle button', () => {
    renderHeader();
    expect(screen.getByTitle('تكبير حجم الخط')).toBeInTheDocument();
  });

  it('font-size toggle title changes when large', () => {
    renderHeader({ fontScale: 'large' });
    expect(screen.getByTitle('إرجاع حجم الخط للطبيعي')).toBeInTheDocument();
  });

  it('renders the updated header title and subtitle for stock tab', () => {
    renderHeader({ activeTab: 'stock' });
    expect(screen.getByText('متابع مخزون الأدوية')).toBeInTheDocument();
    expect(screen.getByText('حساب استهلاك الأدوية وتنبيهات النفاذ تلقائياً')).toBeInTheDocument();
  });
});

describe('AppHeader — independent dose reminder vs critical stock toggles', () => {
  afterEach(() => cleanup());

  it('can show dose reminders OFF and critical stock ON at the same time', () => {
    const onToggleNotifications = vi.fn();
    const onToggleCriticalStockAlerts = vi.fn();
    renderHeader({
      notificationsEnabled: false,
      criticalStockAlertsEnabled: true,
      onToggleNotifications,
      onToggleCriticalStockAlerts,
    });

    const doseBtn = screen.getByRole('button', {
      name: 'تذكيرات مواعيد الجرعات متوقفة — انقر للتفعيل',
    });
    const criticalBtn = screen.getByRole('button', {
      name: 'تنبيه النفاذ الحرج مفعّل',
    });

    expect(doseBtn).toHaveAttribute('aria-pressed', 'false');
    expect(criticalBtn).toHaveAttribute('aria-pressed', 'true');

    doseBtn.click();
    expect(onToggleNotifications).toHaveBeenCalledTimes(1);
    expect(onToggleCriticalStockAlerts).not.toHaveBeenCalled();

    criticalBtn.click();
    expect(onToggleCriticalStockAlerts).toHaveBeenCalledTimes(1);
    expect(onToggleNotifications).toHaveBeenCalledTimes(1);
  });
});
