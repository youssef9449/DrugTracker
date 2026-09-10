import type { FC } from 'react';
import { Pill, ShoppingCart, History, Store } from 'lucide-react';

export type ActiveTab = 'stock' | 'shopping' | 'pharmacies' | 'logs';

interface AndroidBottomNavProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  alertsCount: number;
}

/** Tab configuration — drives the .map() so the 4 tab buttons share one
 *  template (audit #83, replacing 4 copy-pasted button blocks). */
const TABS: { id: ActiveTab; icon: typeof Pill; label: string }[] = [
  { id: 'stock', icon: Pill, label: 'المخزون' },
  { id: 'shopping', icon: ShoppingCart, label: 'قائمة الشراء' },
  { id: 'pharmacies', icon: Store, label: 'الصيدليات' },
  { id: 'logs', icon: History, label: 'سجل الاستهلاك' },
];

export const AndroidBottomNav: FC<AndroidBottomNavProps> = ({
  activeTab,
  onTabChange,
  alertsCount,
}) => {
  return (
    <nav className="w-full bg-white border-t border-slate-200/90 px-3 py-2 flex items-center justify-around select-none z-30 shadow-md">
      {TABS.map(({ id, icon: Icon, label }) => {
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
              className={`px-4 py-1 rounded-full flex items-center justify-center relative transition ${
                isActive ? 'bg-teal-100 text-teal-800' : 'bg-transparent'
              }`}
            >
              <Icon className="w-5 h-5 rotate-45" />
              {id === 'shopping' && alertsCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-rose-600 text-white font-mono text-[10px] font-bold rounded-full flex items-center justify-center px-1 border-2 border-white animate-pulse">
                  {alertsCount}
                </span>
              )}
            </div>
            <span className="text-[11px] mt-1">{label}</span>
          </button>
        );
      })}
    </nav>
  );
};
