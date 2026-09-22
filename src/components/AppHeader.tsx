import { type FC } from 'react';
import { Bell, BellOff, Search, Smartphone, Monitor, Settings, AlertTriangle, Check, X, Zap, ZapOff } from 'lucide-react';
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
  globalAutoDeductEnabled: boolean;
  onToggleGlobalAutoDeduct: () => void;
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
  globalAutoDeductEnabled,
  onToggleGlobalAutoDeduct,
  fontScale,
  onToggleFontScale,
}) => {
  // #84: Single HEADER_BY_TAB map replacing the 3 parallel switch
  // statements (getHeaderIcon / getHeaderTitle / getHeaderSubtitle).
  // 'pharmacies' falls back to the stock values (same as the old default
  // case — no separate pharmacies header was defined).
  const header = HEADER_BY_TAB[activeTab] ?? HEADER_BY_TAB.stock;

  return (
    <header className="bg-teal-800 text-white shadow-xs">
      {/* Top App Bar */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold tracking-tight">{header.title}</h1>
          <p className="text-[11px] text-teal-200/90 font-medium">
            {header.subtitle}
          </p>
        </div>

        {/* Quick Action Icons */}
        <div className="flex items-center gap-1">
          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            title="الإعدادات"
            className={ICON_BUTTON_CLASS}
            aria-label="الإعدادات"
          >
            <Settings className="w-5 h-5" />
          </button>

          {/* Global Auto-Deduct toggle */}
          <button
            type="button"
            onClick={onToggleGlobalAutoDeduct}
            title={
              globalAutoDeductEnabled
                ? 'الخصم التلقائي لجميع الأدوية مفعّل (انقر للإيقاف)'
                : 'الخصم التلقائي لجميع الأدوية متوقف (انقر للتفعيل)'
            }
            aria-label={
              globalAutoDeductEnabled
                ? 'الخصم التلقائي لجميع الأدوية مفعّل — انقر للإيقاف'
                : 'الخصم التلقائي لجميع الأدوية متوقف — انقر للتفعيل'
            }
            aria-pressed={globalAutoDeductEnabled}
            className="w-10 h-10 rounded-full transition-all active:scale-95 flex items-center justify-center cursor-pointer text-teal-200"
          >
            {globalAutoDeductEnabled ? (
              <Zap className="w-5 h-5" />
            ) : (
              <ZapOff className="w-5 h-5" />
            )}
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
            className={`w-10 h-10 rounded-full transition-all active:scale-95 relative flex items-center justify-center cursor-pointer ${
              notificationsEnabled
                ? 'bg-amber-400/25 text-amber-300 ring-1 ring-amber-400/40 shadow-xs'
                : 'text-teal-200/80 hover:text-white hover:bg-teal-700/60'
            }`}
          >
            {notificationsEnabled ? (
              <>
                <Bell className="w-5 h-5 fill-amber-300" />
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-teal-900 animate-pulse" />
              </>
            ) : (
              <BellOff className="w-5 h-5" />
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
            className={`w-10 h-10 rounded-full transition-all active:scale-95 relative flex items-center justify-center cursor-pointer ${
              criticalStockAlertsEnabled
                ? 'bg-rose-500/30 text-rose-200 ring-1 ring-rose-400/40 shadow-xs'
                : 'text-teal-200/80 hover:text-white hover:bg-teal-700/60'
            }`}
          >
            <AlertTriangle
              className={`w-5 h-5 ${
                criticalStockAlertsEnabled ? 'fill-rose-300/30 text-rose-200' : 'opacity-70'
              }`}
            />
          </button>

          {/* Device Mockup frame toggle (hidden on mobile, visible on larger screens) */}
          <button
            onClick={onTogglePhoneFrame}
            title={isPhoneFrame ? 'التبديل إلى وضع الشاشة الكاملة' : 'التبديل إلى مظهر هاتف أندرويد'}
            aria-label={isPhoneFrame ? 'التبديل إلى وضع الشاشة الكاملة' : 'التبديل إلى مظهر هاتف أندرويد'}
            className={`hidden md:flex ${ICON_BUTTON_CLASS}`}
          >
            {isPhoneFrame ? <Monitor className="w-5 h-5" /> : <Smartphone className="w-5 h-5" />}
          </button>

          {/* Font size toggle */}
          <button
            onClick={onToggleFontScale}
            title={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            aria-label={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition active:scale-95 font-bold leading-none cursor-pointer ${
              fontScale === 'large'
                ? 'bg-white/20 text-white shadow-xs ring-1 ring-white/30'
                : 'text-teal-100 hover:text-white hover:bg-teal-700/60'
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
        <div className="px-4 pb-3.5 space-y-3">
          {/* M3 Search Bar (Full Pill shape, height 44px, leading icon, trailing clear) */}
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
              className="w-full h-11 pl-9 pr-10 rounded-full bg-teal-900/50 border border-teal-600/70 text-white placeholder-teal-300/70 text-sm focus:outline-none focus:ring-2 focus:ring-teal-300 focus:bg-teal-900/80 transition-all shadow-inner [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
            />
            <Search className="w-5 h-5 text-teal-200 absolute right-3.5 top-3 pointer-events-none" />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label="مسح البحث"
                title="مسح البحث"
                className="absolute left-2.5 top-2.5 w-6 h-6 rounded-full flex items-center justify-center text-teal-200 hover:text-white hover:bg-teal-800/80 active:bg-teal-700 transition cursor-pointer"
              >
                <X className="w-4 h-4 stroke-[2.5]" />
              </button>
            )}
          </div>

          {/* M3 Filter Chips (8dp rounded rectangle, 32dp height with checkmark on selection) */}
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5 no-scrollbar text-xs">
            <button
              type="button"
              onClick={() => onFilterChange('all')}
              className={`h-8 px-3 rounded-lg font-medium transition whitespace-nowrap flex items-center gap-1.5 active:scale-95 border cursor-pointer select-none ${
                filter === 'all'
                  ? 'bg-white text-teal-950 font-bold border-white shadow-xs'
                  : 'bg-teal-700/50 text-teal-100 border-teal-600/50 hover:bg-teal-700/80'
              }`}
            >
              {filter === 'all' && <Check className="w-3.5 h-3.5 text-teal-900 stroke-[2.5]" />}
              <span>جميع الأدوية</span>
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('alerts')}
              className={`h-8 px-3 rounded-lg font-medium transition whitespace-nowrap flex items-center gap-1.5 active:scale-95 border cursor-pointer select-none ${
                filter === 'alerts'
                  ? 'bg-white text-teal-950 font-bold border-white shadow-xs'
                  : 'bg-teal-700/50 text-teal-100 border-teal-600/50 hover:bg-teal-700/80'
              }`}
            >
              {filter === 'alerts' && <Check className="w-3.5 h-3.5 text-teal-900 stroke-[2.5]" />}
              <span>قارب على النفاذ</span>
              {alertsCount > 0 && (
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold transition ${
                    filter === 'alerts'
                      ? 'bg-rose-100 text-rose-800 border border-rose-200'
                      : 'bg-rose-700 text-white'
                  }`}
                >
                  {alertsCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('sufficient')}
              className={`h-8 px-3 rounded-lg font-medium transition whitespace-nowrap flex items-center gap-1.5 active:scale-95 border cursor-pointer select-none ${
                filter === 'sufficient'
                  ? 'bg-white text-teal-950 font-bold border-white shadow-xs'
                  : 'bg-teal-700/50 text-teal-100 border-teal-600/50 hover:bg-teal-700/80'
              }`}
            >
              {filter === 'sufficient' && <Check className="w-3.5 h-3.5 text-teal-900 stroke-[2.5]" />}
              <span>المخزون الكافي</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
