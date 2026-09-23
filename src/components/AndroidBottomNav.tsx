import type { FC } from 'react';
import { Pill, ShoppingCart, History, Store, ContactRound } from 'lucide-react';
export type ActiveTab = 'stock' | 'shopping' | 'pharmacies' | 'user-data' | 'logs';
interface AndroidBottomNavProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  alertsCount: number;
}
/** Tab configuration — drives the .map() so the tab buttons share one
 *  template. */
const TABS: { id: ActiveTab; icon: typeof Pill; label: string; iconClassName?: string }[] = [
  { id: 'stock', icon: Pill, label: 'المخزون', iconClassName: 'rotate-45' },
  { id: 'shopping', icon: ShoppingCart, label: 'قائمة الشراء' },
  { id: 'pharmacies', icon: Store, label: 'الصيدليات' },
  { id: 'user-data', icon: ContactRound, label: 'بياناتي' },
  { id: 'logs', icon: History, label: 'سجل الاستهلاك' },
];
export const AndroidBottomNav: FC<AndroidBottomNavProps> = ({
  activeTab,
  onTabChange,
  alertsCount,
}) => {
  return (
    <nav
      className="w-full bg-[#f8faf9] border-t border-slate-200/90 px-2 py-2 flex items-center justify-around select-none z-30 shadow-[0_-1px_3px_rgba(0,0,0,0.05)] h-20"
      aria-label="شريط التنقل الرئيسي"
    >
      {TABS.map(({ id, icon: Icon, label, iconClassName }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className="flex-1 flex flex-col items-center justify-center py-1 transition-all group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/40 rounded-xl"
            aria-selected={isActive}
            role="tab"
          >
            <div
              className={`w-16 h-8 rounded-full flex items-center justify-center relative transition-all duration-200 ${
                isActive
                  ? 'bg-teal-100 text-teal-950 shadow-xs'
                  : 'bg-transparent text-slate-600 group-hover:bg-slate-200/50 group-hover:text-slate-900'
              }`}
            >
              <Icon className={`w-5 h-5 transition-transform duration-200 ${isActive ? 'scale-105' : ''} ${iconClassName ?? ''}`} />
              {id === 'shopping' && alertsCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-red-600 text-white font-mono text-[10px] font-bold rounded-full flex items-center justify-center px-1 border-2 border-[#f8faf9] shadow-xs">
                  {alertsCount}
                </span>
              )}
            </div>
            <span
              className={`text-[11px] sm:text-xs mt-1 transition-colors tracking-tight ${
                isActive ? 'text-teal-950 font-bold' : 'text-slate-600 font-medium group-hover:text-slate-900'
              }`}
            >
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
};