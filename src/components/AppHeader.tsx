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
    <header className="bg-white text-slate-900 border-b border-slate-200">
      {/* Top App Bar */}
      <div className="min-h-16 px-4 py-2 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium leading-6 tracking-tight">{header.title}</h1>
          <p className="text-xs text-slate-600 leading-4">
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
            <Settings className="w-4 h-4" />
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
            className={`w-10 h-10 rounded-full transition-colors relative flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 ${
              notificationsEnabled
                ? 'bg-teal-100 text-teal-900'
                : 'text-slate-600 hover:bg-slate-100 active:bg-slate-200'
            }`}
          >
            {notificationsEnabled ? (
              <>
                <Bell className="w-5 h-5 fill-teal-800/10 text-teal-900" />
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-600 ring-2 ring-white animate-pulse" />
              </>
            ) : (
              <BellOff className="w-4 h-4" />
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
            className={`w-10 h-10 rounded-full transition-colors relative flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 ${criticalStockAlertsEnabled ? 'bg-rose-100 text-rose-800' : 'text-slate-600 hover:bg-slate-100 active:bg-slate-200'}`}
          >
            <AlertTriangle
              className={`w-4 h-4 ${
                criticalStockAlertsEnabled ? 'fill-rose-200 text-rose-800' : 'text-slate-600'
              }`}
            />
          </button>


          {/* Device Mockup frame toggle (hidden on mobile, visible on larger screens) */}
          <button
            onClick={onTogglePhoneFrame}
            title={isPhoneFrame ? 'التبديل إلى وضع الشاشة الكاملة' : 'التبديل إلى مظهر هاتف أندرويد'}
            className={`hidden md:flex ${ICON_BUTTON_CLASS}`}
          >
            {isPhoneFrame ? <Monitor className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
          </button>

          {/* Font size toggle — compact A+/A- only (no Type icon) */}
          <button
            onClick={onToggleFontScale}
            title={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            aria-label={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            className={`min-w-10 h-10 rounded-full transition-colors flex items-center justify-center font-bold leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 ${
              fontScale === 'large'
                ? 'bg-teal-100 text-teal-900'
                : 'text-slate-700 hover:bg-slate-100 active:bg-slate-200'
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
              className="w-full h-14 pl-11 pr-11 rounded-full bg-slate-100 border border-transparent text-slate-900 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:bg-white focus:border-slate-300 transition-colors [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
            />
            <Search className="w-5 h-5 text-slate-600 absolute right-4 top-4 pointer-events-none" />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label="مسح البحث"
                title="مسح البحث"
                className="absolute left-3 top-4 w-6 h-6 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-200 active:bg-slate-300 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            )}
          </div>

          {/* M3 Filter Chips (8dp rounded rectangle with checkmark on selection) */}
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5 no-scrollbar text-xs">
            <button
              type="button"
              onClick={() => onFilterChange('all')}
              className={`h-10 px-4 rounded-full font-medium transition-colors whitespace-nowrap flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 cursor-pointer ${
                filter === 'all'
                  ? 'bg-teal-100 text-teal-950 font-medium'
                  : 'bg-transparent text-slate-700 border border-slate-400 hover:bg-slate-100 active:bg-slate-200'
              }`}
            >
              {filter === 'all' && <Check className="w-3.5 h-3.5 text-teal-900 stroke-[2.5]" />}
              <span>جميع الأدوية</span>
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('alerts')}
              className={`h-10 px-4 rounded-full font-medium transition-colors whitespace-nowrap flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 cursor-pointer ${filter === 'alerts' ? 'bg-teal-100 text-teal-950' : 'bg-transparent text-slate-700 border border-slate-400 hover:bg-slate-100 active:bg-slate-200'}`}
            >
              {filter === 'alerts' && <Check className="w-3.5 h-3.5 text-teal-900 stroke-[2.5]" />}
              <span>قارب على النفاذ</span>
              {alertsCount > 0 && (
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold transition ${
                    filter === 'alerts'
                      ? 'bg-rose-100 text-rose-800'
                      : 'bg-rose-600 text-white'
                  }`}
                >
                  {alertsCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => onFilterChange('sufficient')}
              className={`h-10 px-4 rounded-full font-medium transition-colors whitespace-nowrap flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 cursor-pointer ${filter === 'sufficient' ? 'bg-teal-100 text-teal-950' : 'bg-transparent text-slate-700 border border-slate-400 hover:bg-slate-100 active:bg-slate-200'}`}
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
