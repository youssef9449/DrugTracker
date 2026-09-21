import { type FC } from 'react';
import { Bell, BellOff, Search, Smartphone, Monitor, Settings, AlertTriangle, Check, X } from 'lucide-react';
import { ActiveTab } from './AndroidBottomNav';
import { ICON_BUTTON_CLASS } from '../lib/styles';

const HEADER_BY_TAB: Record<ActiveTab, {
  title: string;
  subtitle: string;
}> = {
  stock: {
    title: 'متابع مخزون الأدوية',
    subtitle: 'حساب استهلاك الأدوية وتنبيهات النفاذ تلقائياً',
  },
  shopping: {
    title: 'قائمة الشراء والصيدلية',
    subtitle: 'تجهيز طلب الواتساب وحساب الكميات',
  },
  pharmacies: {
    title: 'إدارة الصيدليات',
    subtitle: 'أرقام وعناوين الصيدليات لطلب الأدوية عبر واتساب',
  },
  'user-data': {
    title: 'بياناتي',
    subtitle: 'أرقام التواصل وعناوين التوصيل لطلب الأدوية',
  },
  logs: {
    title: 'سجل الاستهلاك',
    subtitle: 'متابعة الجرعات المسجلة وحركات المخزون',
  },
};

interface AppHeaderProps {
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

export const AppHeader: FC<AppHeaderProps> = ({
  activeTab,
  filter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  alertsCount,
  notificationsEnabled,
  onToggleNotifications,
  criticalStockAlertsEnabled,
  onToggleCriticalStockAlerts,
  isPhoneFrame,
  onTogglePhoneFrame,
  onOpenSettings,
  fontScale,
  onToggleFontScale,
}) => {
  // #84: Single HEADER_BY_TAB map replacing the 3 parallel switch
  // statements (getHeaderIcon / getHeaderTitle / getHeaderSubtitle).
  // 'pharmacies' falls back to the stock values (same as the old default
  // case — no separate pharmacies header was defined).
  const header = HEADER_BY_TAB[activeTab] ?? HEADER_BY_TAB.stock;

  return (
    <header className="bg-m3-surface text-m3-on-surface border-b border-m3-outline-variant">
      {/* Top App Bar */}
      <div className="min-h-16 px-4 py-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium leading-6 tracking-tight">{header.title}</h1>
          <p className="text-xs text-m3-on-surface-variant leading-4">
            {header.subtitle}
          </p>
        </div>

        {/* Quick Action Icons */}
        <div className="flex items-center gap-0.5">
          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            title="الإعدادات"
            className={ICON_BUTTON_CLASS}
          >
            <Settings className="w-6 h-6" />
          </button>

          {/* Browser / In-App Notification toggle */}
          <button
            onClick={onToggleNotifications}
            title={
              notificationsEnabled
                ? 'تذكيرات مواعيد الجرعات مفعّلة (انقر للإيقاف)'
                : 'تذكيرات مواعيد الجرعات متوقفة (انقر للتفعيل)'
            }
            aria-label={
              notificationsEnabled
                ? 'تذكيرات مواعيد الجرعات مفعّلة — انقر للإيقاف'
                : 'تذكيرات مواعيد الجرعات متوقفة — انقر للتفعيل'
            }
            aria-pressed={notificationsEnabled}
            className={`w-12 h-12 rounded-full transition-colors relative flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary/30 ${
              notificationsEnabled
                ? 'bg-m3-primary-container text-m3-on-primary-container'
                : 'text-m3-on-surface-variant hover:bg-m3-surface-container active:bg-m3-surface-container-high'
            }`}
          >
            {notificationsEnabled ? (
              <>
                <Bell className="w-6 h-6 fill-m3-primary/10 text-m3-on-primary-container" />
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-m3-primary ring-2 ring-m3-surface animate-pulse" />
              </>
            ) : (
              <BellOff className="w-6 h-6" />
            )}
          </button>

          {/* Critical-stock alerts toggle */}
          <button
            onClick={onToggleCriticalStockAlerts}
            title={
              criticalStockAlertsEnabled
                ? 'تنبيه النفاذ الحرج مفعّل (انقر للإيقاف)'
                : 'تنبيه النفاذ الحرج متوقف (انقر للتفعيل)'
            }
            aria-label={
              criticalStockAlertsEnabled
                ? 'تنبيه النفاذ الحرج مفعّل'
                : 'تنبيه النفاذ الحرج متوقف'
            }
            aria-pressed={criticalStockAlertsEnabled}
            className={`w-12 h-12 rounded-full transition-colors relative flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary/30 ${criticalStockAlertsEnabled ? 'bg-m3-error-container text-m3-on-error-container' : 'text-m3-on-surface-variant hover:bg-m3-surface-container active:bg-m3-surface-container-high'}`}
          >
            <AlertTriangle
              className={`w-6 h-6 ${
                criticalStockAlertsEnabled ? 'fill-m3-error-container text-m3-error' : 'text-m3-on-surface-variant'
              }`}
            />
          </button>


          {/* Device Mockup frame toggle (hidden on mobile, visible on larger screens) */}
          <button
            onClick={onTogglePhoneFrame}
            title={isPhoneFrame ? 'التبديل إلى وضع الشاشة الكاملة' : 'التبديل إلى مظهر هاتف أندرويد'}
            className={`hidden md:flex ${ICON_BUTTON_CLASS}`}
          >
            {isPhoneFrame ? <Monitor className="w-6 h-6" /> : <Smartphone className="w-6 h-6" />}
          </button>

          {/* Font size toggle — compact A+/A- only (no Type icon) */}
          <button
            onClick={onToggleFontScale}
            title={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            aria-label={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            className={`min-w-12 h-12 rounded-full transition-colors flex items-center justify-center font-bold leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary/30 ${
              fontScale === 'large'
                ? 'bg-m3-primary-container text-m3-on-primary-container'
                : 'text-m3-on-surface hover:bg-m3-surface-container active:bg-m3-surface-container-high'
            }`}
          >
            <span className="font-mono text-xs">
              {fontScale === 'large' ? 'A-' : 'A+'}
            </span>
          </button>
        </div>
      </div>

      {/* In Stock Tab: Search and Filters (M3 Search Bar & Filter Chips) */}
      {activeTab === 'stock' && (
        <div className="px-4 pb-3 space-y-3">
          {/* M3 Search Bar (Full Pill shape with surface container color) */}
          <div className="relative">
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
              placeholder="بحث عن دواء..."
              className="w-full h-14 pl-14 pr-14 rounded-full bg-m3-surface-container border border-transparent text-m3-on-surface placeholder:text-m3-on-surface-variant text-sm focus:outline-none focus:ring-2 focus:ring-m3-primary/30 focus:bg-m3-surface focus:border-m3-outline-variant transition-colors [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
            />
            <Search className="w-6 h-6 text-m3-on-surface-variant absolute right-4 top-4 pointer-events-none" />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label="مسح البحث"
                title="مسح البحث"
                className="absolute left-1 top-1 w-12 h-12 rounded-full flex items-center justify-center text-m3-on-surface-variant hover:bg-m3-surface-container-high active:bg-m3-surface-container-high transition-colors cursor-pointer"
              >
                <X className="w-6 h-6 stroke-[2.25]" />
              </button>
            )}
          </div>

          {/* M3 Filter Chips: 40dp height, outlined/unselected and tonal selected state. */}
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5 no-scrollbar text-xs">
            <button
              type="button"
              onClick={() => onFilterChange('all')}
              className={`h-10 px-4 rounded-lg font-medium transition-colors whitespace-nowrap flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary/30 cursor-pointer ${
                filter === 'all'
                  ? 'bg-m3-primary-container text-m3-on-primary-container font-medium'
                  : 'bg-transparent text-m3-on-surface border border-m3-outline hover:bg-m3-surface-container active:bg-m3-surface-container-high'
              }`}
            >
              {filter === 'all' && <Check className="w-4 h-4 text-m3-on-primary-container stroke-[2.5]" />}
              <span>جميع الأدوية</span>
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('alerts')}
              className={`h-10 px-4 rounded-lg font-medium transition-colors whitespace-nowrap flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary/30 cursor-pointer ${filter === 'alerts' ? 'bg-m3-primary-container text-m3-on-primary-container' : 'bg-transparent text-m3-on-surface border border-m3-outline hover:bg-m3-surface-container active:bg-m3-surface-container-high'}`}
            >
              {filter === 'alerts' && <Check className="w-4 h-4 text-m3-on-primary-container stroke-[2.5]" />}
              <span>قارب على النفاذ</span>
              {alertsCount > 0 && (
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold transition ${
                    filter === 'alerts'
                      ? 'bg-m3-error-container text-m3-on-error-container'
                      : 'bg-m3-error text-m3-on-error'
                  }`}
                >
                  {alertsCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('sufficient')}
              className={`h-10 px-4 rounded-lg font-medium transition-colors whitespace-nowrap flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary/30 cursor-pointer ${filter === 'sufficient' ? 'bg-m3-primary-container text-m3-on-primary-container' : 'bg-transparent text-m3-on-surface border border-m3-outline hover:bg-m3-surface-container active:bg-m3-surface-container-high'}`}
            >
              {filter === 'sufficient' && <Check className="w-4 h-4 text-m3-on-primary-container stroke-[2.5]" />}
              <span>المخزون الكافي</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
