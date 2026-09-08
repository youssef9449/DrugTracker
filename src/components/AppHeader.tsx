import React from 'react';
import { Pill, Bell, BellOff, Volume2, VolumeX, Search, Smartphone, Monitor, ShoppingCart, History, Settings, AlertTriangle } from 'lucide-react';
import { ActiveTab } from './AndroidBottomNav';

interface AppHeaderProps {
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
  /**
   * Whether the "متبقي حبتين فقط" critical-stock alert is enabled.
   * Default true (the headline feature). When false, no critical
   * stock notification is sent by sendCriticalStockAlert().
   */
  criticalStockAlertsEnabled: boolean;
  onToggleCriticalStockAlerts: () => void;
  isPhoneFrame: boolean;
  onTogglePhoneFrame: () => void;
  onOpenSettings: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  activeTab,
  filter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  alertsCount,
  notificationsEnabled,
  onToggleNotifications,
  soundEnabled,
  onToggleSound,
  criticalStockAlertsEnabled,
  onToggleCriticalStockAlerts,
  isPhoneFrame,
  onTogglePhoneFrame,
  onOpenSettings,
}) => {
  const getHeaderIcon = () => {
    switch (activeTab) {
      case 'shopping':
        return <ShoppingCart className="w-5 h-5 text-white" />;
      case 'logs':
        return <History className="w-5 h-5 text-white" />;
      default:
        return <Pill className="w-5 h-5 rotate-45 text-white" />;
    }
  };

  const getHeaderTitle = () => {
    switch (activeTab) {
      case 'shopping':
        return 'قائمة الشراء والصيدلية';
      case 'logs':
        return 'سجل الاستهلاك اليومي';
      default:
        return 'متابع مخزون الأدوية';
    }
  };

  const getHeaderSubtitle = () => {
    switch (activeTab) {
      case 'shopping':
        return 'تجهيز طلب الواتساب وحساب الكميات';
      case 'logs':
        return 'تتبع الخصم التلقائي عبر مرور الأيام';
      default:
        return 'حساب استهلاك الحبوب وتنبيهات النفاد تلقائياً';
    }
  };

  return (
    <header className="bg-teal-800 text-white shadow-xs">
      {/* Top App Bar */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-teal-700/80 border border-teal-600/50 flex items-center justify-center text-teal-100 shadow-xs">
            {getHeaderIcon()}
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">{getHeaderTitle()}</h1>
            <p className="text-[11px] text-teal-200/90 font-medium">
              {getHeaderSubtitle()}
            </p>
          </div>
        </div>

        {/* Quick Action Icons
            NOTE: "إضافة دواء جديد" was previously rendered here as a small
            button in the header bar. It was redundant because the floating
            action button (AndroidFab) at the bottom-left of the stock tab
            already opens the same modal, and the EmptyState component shows
            its own "أضف أول دواء الآن" button when the medication list is
            empty. Keeping only the FAB avoids two actions pointing at the
            same target and frees up header space for the toggle icons. */}
        <div className="flex items-center gap-1.5">
          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            title="إعدادات الصيدلية والواتساب"
            className="p-2 rounded-xl text-teal-100 hover:text-white hover:bg-teal-700/80 transition active:scale-95"
          >
            <Settings className="w-4 h-4" />
          </button>

          {/* Audio toggle */}
          <button
            onClick={onToggleSound}
            title={soundEnabled ? 'كتم التأثيرات الصوتية' : 'تفعيل التأثيرات الصوتية'}
            className="p-2 rounded-xl text-teal-100 hover:text-white hover:bg-teal-700/80 transition active:scale-95"
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4 text-teal-300/60" />}
          </button>

          {/* Browser Notification toggle */}
          <button
            onClick={onToggleNotifications}
            title={notificationsEnabled ? 'التنبيهات مفعلة' : 'تفعيل إشعارات الهاتف'}
            className={`p-2 rounded-xl transition active:scale-95 relative ${
              notificationsEnabled
                ? 'bg-teal-700 text-amber-300'
                : 'text-teal-200 hover:text-white hover:bg-teal-700/80'
            }`}
          >
            {notificationsEnabled ? <Bell className="w-4 h-4 fill-amber-300/30" /> : <BellOff className="w-4 h-4" />}
            {alertsCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-teal-800 animate-pulse" />
            )}
          </button>

          {/* Critical-stock alerts toggle ("متبقي حبتين فقط")
              — separate from the master notification toggle because
              the user explicitly asked for it to be its own switch.
              When this is ON, the app fires a high-priority
              notification when any medication drops to 2 pills or
              fewer. When OFF, no critical stock alert fires (other
              notifications like dose reminders still work). */}
          <button
            onClick={onToggleCriticalStockAlerts}
            title={
              criticalStockAlertsEnabled
                ? 'تنبيه "حبتين بس" مفعّل — هتوصلك إشعار لو في دواء متبقي فيه حبتين أو أقل'
                : 'فعّل تنبيه "حبتين بس" (مهم جداً)'
            }
            className={`p-2 rounded-xl transition active:scale-95 relative ${
              criticalStockAlertsEnabled
                ? 'bg-rose-600/40 text-rose-100 ring-1 ring-rose-300/50'
                : 'text-teal-200 hover:text-white hover:bg-teal-700/80'
            }`}
          >
            <AlertTriangle className={`w-4 h-4 ${criticalStockAlertsEnabled ? 'fill-rose-200/20' : ''}`} />
          </button>

          {/* Device Mockup frame toggle (hidden on mobile, visible on larger screens) */}
          <button
            onClick={onTogglePhoneFrame}
            title={isPhoneFrame ? 'التبديل إلى وضع الشاشة الكاملة' : 'التبديل إلى مظهر هاتف أندرويد'}
            className="hidden md:flex p-2 rounded-xl text-teal-100 hover:text-white hover:bg-teal-700/80 transition active:scale-95"
          >
            {isPhoneFrame ? <Monitor className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
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
              <span>قارب على النفاد</span>
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
