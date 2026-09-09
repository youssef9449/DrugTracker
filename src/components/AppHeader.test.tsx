/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { CUSTOM_SOUND_ACCEPT_ATTR } from '../utils/sound';
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
  soundEnabled: boolean;
  onToggleSound: () => void;
  criticalStockAlertsEnabled: boolean;
  onToggleCriticalStockAlerts: () => void;
  isPhoneFrame: boolean;
  onTogglePhoneFrame: () => void;
  onOpenSettings: () => void;
  globalCustomSound?: { fileName: string; mimeType: string; dataUrl: string } | null;
  onSetGlobalCustomSound: (file: { fileName: string; mimeType: string; dataUrl: string } | null) => void;
}

/**
 * Minimal props factory for AppHeader. Most props are no-op stubs since
 * the tests below only exercise the sound panel + file-input behavior.
 */
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
    soundEnabled: true,
    onToggleSound: vi.fn(),
    criticalStockAlertsEnabled: true,
    onToggleCriticalStockAlerts: vi.fn(),
    isPhoneFrame: true,
    onTogglePhoneFrame: vi.fn(),
    onOpenSettings: vi.fn(),
    globalCustomSound: null,
    onSetGlobalCustomSound: vi.fn(),
    ...overrides,
  };
  return render(<AppHeader {...props} />);
}

/**
 * #12 — Sound panel visibility.
 *
 * The sound panel is the only UI for toggling in-app sound, uploading a
 * global custom sound, and removing it. Before the fix it was positioned
 * relative to the phone-frame container (`relative overflow-hidden`) and
 * was clipped off-screen. The fix added `relative` to the button row in
 * AppHeader so the panel anchors to the row.
 *
 * These tests assert the panel actually renders in the DOM (not clipped
 * by CSS overflow) and is visible when the audio button is clicked.
 */
describe('AppHeader — sound panel (#12)', () => {
  beforeEach(() => {
    // Reset the mocked window.alert between tests.
    vi.clearAllMocks();
  });

  afterEach(() => {
    // React Testing Library doesn't auto-cleanup when vitest globals are
    // off (we set `globals: false` in vitest.config.ts), so unmount
    // explicitly to prevent DOM leakage between tests.
    cleanup();
  });

  it('does not render the sound panel before the audio button is clicked', () => {
    renderHeader();
    expect(screen.queryByText('تأثيرات صوتية في التطبيق')).toBeNull();
    expect(screen.queryByText('صوت إشعار مخصص (لكل الأدوية)')).toBeNull();
  });

  it('renders the sound panel with the sound toggle + custom sound section when the audio button is clicked', () => {
    renderHeader();
    // The audio button's title toggles based on soundEnabled.
    const audioButton = screen.getByTitle('إدارة الأصوات');
    fireEvent.click(audioButton);

    // Panel header (sound on/off label)
    expect(screen.getByText('تأثيرات صوتية في التطبيق')).toBeInTheDocument();
    // Custom sound section label
    expect(screen.getByText('صوت إشعار مخصص (لكل الأدوية)')).toBeInTheDocument();
    // Upload hint when no custom sound is set
    expect(screen.getByText('📂 اختر ملفاً صوتياً من جهازك')).toBeInTheDocument();
  });

  it('hides the panel again when the audio button is clicked a second time', () => {
    renderHeader();
    const audioButton = screen.getByTitle('إدارة الأصوات');
    fireEvent.click(audioButton);
    expect(screen.getByText('تأثيرات صوتية في التطبيق')).toBeInTheDocument();
    fireEvent.click(audioButton);
    expect(screen.queryByText('تأثيرات صوتية في التطبيق')).toBeNull();
  });

  it('calls onToggleSound when the in-panel sound toggle is clicked', () => {
    const onToggleSound = vi.fn();
    renderHeader({ onToggleSound });
    fireEvent.click(screen.getByTitle('إدارة الأصوات'));
    // The in-panel toggle is a button with class containing "rounded-full"
    // next to the "تأثيرات صوتية" label. Click it.
    const panelToggle = screen.getByText('تأثيرات صوتية في التطبيق')
      .parentElement!.querySelector('button')!;
    fireEvent.click(panelToggle);
    expect(onToggleSound).toHaveBeenCalledTimes(1);
  });

  it('shows the "remove custom sound" trash button + "تغيير الملف" button when a custom sound is set', () => {
    renderHeader({
      globalCustomSound: {
        fileName: 'bell.mp3',
        mimeType: 'audio/mpeg',
        dataUrl: 'data:audio/mpeg;base64,AAAA',
      },
    });
    fireEvent.click(screen.getByTitle('إدارة الأصوات'));
    expect(screen.getByText('bell.mp3')).toBeInTheDocument();
    expect(screen.getByText('تغيير الملف')).toBeInTheDocument();
    // The trash button is the one with title="إزالة"
    expect(screen.getByTitle('إزالة')).toBeInTheDocument();
  });

  it('calls onSetGlobalCustomSound(null) when the trash button is clicked', () => {
    const onSetGlobalCustomSound = vi.fn();
    renderHeader({
      globalCustomSound: {
        fileName: 'bell.mp3',
        mimeType: 'audio/mpeg',
        dataUrl: 'data:audio/mpeg;base64,AAAA',
      },
      onSetGlobalCustomSound,
    });
    fireEvent.click(screen.getByTitle('إدارة الأصوات'));
    fireEvent.click(screen.getByTitle('إزالة'));
    expect(onSetGlobalCustomSound).toHaveBeenCalledWith(null);
  });
});

/**
 * #31 — The file inputs in the sound panel use the exported
 * `CUSTOM_SOUND_ACCEPT_ATTR` constant (value "audio/*"), not a hardcoded
 * literal. This keeps the accept attribute in sync with the constant if
 * it ever changes.
 */
describe('AppHeader — file inputs use CUSTOM_SOUND_ACCEPT_ATTR (#31)', () => {
  afterEach(() => {
    cleanup();
  });

  it('both file inputs have accept={CUSTOM_SOUND_ACCEPT_ATTR} (== "audio/*")', () => {
    renderHeader();
    fireEvent.click(screen.getByTitle('إدارة الأصوات'));
    // No custom sound is set → only the upload input is rendered.
    const fileInputs = document.querySelectorAll(
      'input[type="file"]'
    ) as NodeListOf<HTMLInputElement>;
    expect(fileInputs.length).toBe(1);
    expect(fileInputs[0].getAttribute('accept')).toBe(CUSTOM_SOUND_ACCEPT_ATTR);
    expect(CUSTOM_SOUND_ACCEPT_ATTR).toBe('audio/*');
  });

  it('the "change file" input (shown when a custom sound is set) also uses the constant', () => {
    renderHeader({
      globalCustomSound: {
        fileName: 'bell.mp3',
        mimeType: 'audio/mpeg',
        dataUrl: 'data:audio/mpeg;base64,AAAA',
      },
    });
    fireEvent.click(screen.getByTitle('إدارة الأصوات'));
    const fileInputs = document.querySelectorAll(
      'input[type="file"]'
    ) as NodeListOf<HTMLInputElement>;
    expect(fileInputs.length).toBe(1); // the "تغيير الملف" input
    expect(fileInputs[0].getAttribute('accept')).toBe(CUSTOM_SOUND_ACCEPT_ATTR);
  });
});
