import { type FC } from 'react';
import { Pill, Bell, BellOff, Search, Smartphone, Monitor, ShoppingCart, History, Settings, AlertTriangle, Type, Store, ContactRound } from 'lucide-react';
import { ActiveTab } from './AndroidBottomNav';
import { ICON_BUTTON_CLASS } from '../lib/styles';

// #84: Single map replacing the 3 parallel switch statements
// (getHeaderIcon / getHeaderTitle / getHeaderSubtitle).
const HEADER_BY_TAB: Record<ActiveTab, {
  icon: typeof Pill;
  iconClassName: string;
  title: string;
  subtitle: string;
}> = {
  stock: {
    icon: Pill,
    iconClassName: 'w-5 h-5 rotate-45 text-white',
    title: 'متابع مخزون الأدوية',
    subtitle: 'حساب استهلاك الحبوب وتنبيهات النفاذ تلقائياً',
  },
  shopping: {
    icon: ShoppingCart,
    iconClassName: 'w-5 h-5 text-white',
    title: 'قائمة الشراء والصيدلية',
    subtitle: 'تجهيز طلب الواتساب وحساب الكميات',
  },
  pharmacies: {
    icon: Store,
    iconClassName: 'w-5 h-5 text-white',
    title: 'إدارة الصيدليات',
    subtitle: 'أرقام وعناوين الصيدليات لطلب الأدوية عبر واتساب',
  },
  'user-data': {
    icon: ContactRound,
    iconClassName: 'w-5 h-5 text-white',
    title: 'بياناتي',
    subtitle: 'أرقام التواصل وعناوين التوصيل لطلب الأدوية',
  },
  logs: {
    icon: History,
    iconClassName: 'w-5 h-5 text-white',
    title: 'سجل الاستهلاك اليومي',
    subtitle: 'تتبع الخصم التلقائي عبر مرور الأيام',
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
  const HeaderIcon = header.icon;

  return (
    <header className="bg-teal-800 text-white shadow-xs">
      {/* Top App Bar */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-teal-700/80 border border-teal-600/50 flex items-center justify-center text-teal-100 shadow-xs">
            <HeaderIcon className={header.iconClassName} />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">{header.title}</h1>
            <p className="text-[11px] text-teal-200/90 font-medium">
              {header.subtitle}
            </p>
          </div>
        </div>

        {/* Quick Action Icons */}
        <div className="flex items-center gap-1.5">
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
                ? 'التنبيهات مفعلة (انقر للإيقاف المؤقت)'
                : 'التنبيهات متوقفة (انقر لتفعيل التنبيهات والمنبه)'
            }
            aria-label={
              notificationsEnabled
                ? 'التنبيهات مفعلة — انقر للإيقاف'
                : 'التنبيهات متوقفة — انقر للتفعيل'
            }
            aria-pressed={notificationsEnabled}
            className={`p-2 rounded-xl transition active:scale-95 relative border ${
              notificationsEnabled
                ? 'bg-amber-400/20 text-amber-300 border-amber-400/40 ring-1 ring-amber-400/30 shadow-xs'
                : 'bg-teal-900/40 text-teal-300/70 hover:text-white hover:bg-teal-700/80 border-teal-700/60'
            }`}
          >
            {notificationsEnabled ? (
              <>
                <Bell className="w-4 h-4 fill-amber-300" />
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400 ring-1 ring-teal-900 animate-pulse" />
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
            className={`p-2 rounded-xl transition active:scale-95 relative border ${
              criticalStockAlertsEnabled
                ? 'bg-rose-500/25 text-rose-100 border-rose-400/50 ring-1 ring-rose-400/30 shadow-xs'
                : 'bg-teal-900/40 text-teal-300/70 hover:text-white hover:bg-teal-700/80 border-teal-700/60'
            }`}
          >
            <AlertTriangle
              className={`w-4 h-4 ${
                criticalStockAlertsEnabled ? 'fill-rose-300/30 text-rose-200' : 'opacity-70'
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

          {/* Font size toggle */}
          <button
            onClick={onToggleFontScale}
            title={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            aria-label={fontScale === 'large' ? 'إرجاع حجم الخط للطبيعي' : 'تكبير حجم الخط'}
            className={`px-2 py-1.5 rounded-xl transition active:scale-95 flex items-center gap-1 font-bold text-xs ${
              fontScale === 'large'
                ? 'bg-amber-400 text-teal-950 shadow-xs ring-1 ring-amber-300'
                : 'text-teal-100 hover:text-white hover:bg-teal-700/80 bg-teal-800/40'
            }`}
          >
            <Type className="w-3.5 h-3.5 shrink-0" />
            <span className="font-mono text-[11px] leading-none">
              {fontScale === 'large' ? 'A-' : 'A+'}
            </span>
          </button>
        </div>
      </div>

      {/* In Stock Tab: Search and Filters */}
      {activeTab === 'stock' && (
        <div className="px-4 pb-3 space-y-2.5">
          {/* Search Input */}
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="بحث عن دواء..."
              className="w-full pl-3 pr-9 py-1.5 rounded-xl bg-teal-900/40 border border-teal-700 text-white placeholder-teal-300/70 text-xs focus:outline-none focus:ring-1 focus:ring-teal-300 focus:bg-teal-900/60 transition"
            />
            <Search className="w-4 h-4 text-teal-300/80 absolute right-3 top-2 pointer-events-none" />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                className="absolute left-2.5 top-1.5 text-[11px] text-teal-300 hover:text-white px-1.5 py-0.5 rounded-md bg-teal-800"
              >
                مسح
              </button>
            )}
          </div>

          {/* Filter Chips */}
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5 no-scrollbar text-xs">
            <button
              onClick={() => onFilterChange('all')}
              className={`px-3 py-1.5 rounded-xl font-medium transition whitespace-nowrap active:scale-95 ${
                filter === 'all'
                  ? 'bg-white text-teal-900 font-bold shadow-xs'
                  : 'bg-teal-700/60 text-teal-100 hover:bg-teal-700'
              }`}
            >
              جميع الأدوية
            </button>

            <button
              onClick={() => onFilterChange('alerts')}
              className={`px-3 py-1.5 rounded-xl font-medium transition whitespace-nowrap flex items-center gap-1.5 active:scale-95 ${
                filter === 'alerts'
                  ? 'bg-rose-500 text-white font-bold shadow-xs'
                  : 'bg-teal-700/60 text-teal-100 hover:bg-teal-700'
              }`}
            >
              <span>قارب على النفاذ</span>
              {alertsCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-600 text-white font-mono font-bold">
                  {alertsCount}
                </span>
              )}
            </button>

            <button
              onClick={() => onFilterChange('sufficient')}
              className={`px-3 py-1.5 rounded-xl font-medium transition whitespace-nowrap active:scale-95 ${
                filter === 'sufficient'
                  ? 'bg-white text-teal-900 font-bold shadow-xs'
                  : 'bg-teal-700/60 text-teal-100 hover:bg-teal-700'
              }`}
            >
              المخزون الكافي
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
