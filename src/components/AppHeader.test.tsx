/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import type { ActiveTab } from './AndroidBottomNav';

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

  it('calls onToggleFontScale when clicked', () => {
    const onToggleFontScale = vi.fn();
    renderHeader({ onToggleFontScale });
    fireEvent.click(screen.getByTitle('تكبير حجم الخط'));
    expect(onToggleFontScale).toHaveBeenCalledTimes(1);
  });
});
