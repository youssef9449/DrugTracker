import type { FC } from 'react';
import { Pill, ShoppingCart, History, Store, ContactRound } from 'lucide-react';

export type ActiveTab = 'stock' | 'shopping' | 'pharmacies' | 'user-data' | 'logs';

interface AndroidBottomNavProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  alertsCount: number;
}

/** Tab configuration — drives the .map() so the tab buttons share one
 *  template (audit #83, replacing 4 copy-pasted button blocks). */
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
    <nav className="w-full bg-white border-t border-slate-200/90 px-3 py-2 flex items-center justify-around select-none z-30 shadow-md">
      {TABS.map(({ id, icon: Icon, label, iconClassName }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`flex-1 flex flex-col items-center justify-center py-1 rounded-2xl transition-all duration-200 relative ${
              isActive
                ? 'text-teal-800 font-bold'
                : 'text-slate-500 hover:text-slate-800 font-medium'
            }`}
          >
            <div
              className={`w-14 h-8 rounded-full flex items-center justify-center relative transition-all duration-200 ${
                isActive ? 'bg-teal-100 text-teal-950 font-bold' : 'bg-transparent text-slate-600'
              }`}
            >
              <Icon className={`w-5 h-5 ${iconClassName ?? ''}`} />
              {id === 'shopping' && alertsCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-rose-600 text-white font-mono text-[10px] font-bold rounded-full flex items-center justify-center px-1 border-2 border-white animate-pulse">
                  {alertsCount}
                </span>
              )}
            </div>
            <span
              className={`text-[11px] mt-1 transition-colors ${
                isActive ? 'text-teal-950 font-bold' : 'text-slate-600 font-medium'
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
