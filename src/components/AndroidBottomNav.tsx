import React from 'react';
import { Pill, ShoppingCart, History } from 'lucide-react';

export type ActiveTab = 'stock' | 'shopping' | 'logs';

interface AndroidBottomNavProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  alertsCount: number;
}

export const AndroidBottomNav: React.FC<AndroidBottomNavProps> = ({
  activeTab,
  onTabChange,
  alertsCount,
}) => {
  return (
    <nav className="w-full bg-white border-t border-slate-200/90 px-3 py-2 flex items-center justify-around select-none z-30 shadow-md">
      {/* Tab 1: Stock & Medicines */}
      <button
        onClick={() => onTabChange('stock')}
        className={`flex-1 flex flex-col items-center justify-center py-1 rounded-2xl transition-all duration-200 relative ${
          activeTab === 'stock'
            ? 'text-teal-800 font-bold'
            : 'text-slate-500 hover:text-slate-800 font-medium'
        }`}
      >
        <div
          className={`px-4 py-1 rounded-full flex items-center justify-center transition ${
            activeTab === 'stock' ? 'bg-teal-100 text-teal-800' : 'bg-transparent'
          }`}
        >
          <Pill className="w-5 h-5 rotate-45" />
        </div>
        <span className="text-[11px] mt-1">المخزون</span>
      </button>

      {/* Tab 2: Shopping List & Urgent Alerts */}
      <button
        onClick={() => onTabChange('shopping')}
        className={`flex-1 flex flex-col items-center justify-center py-1 rounded-2xl transition-all duration-200 relative ${
          activeTab === 'shopping'
            ? 'text-teal-800 font-bold'
            : 'text-slate-500 hover:text-slate-800 font-medium'
        }`}
      >
        <div
          className={`px-4 py-1 rounded-full flex items-center justify-center relative transition ${
            activeTab === 'shopping' ? 'bg-teal-100 text-teal-800' : 'bg-transparent'
          }`}
        >
          <ShoppingCart className="w-5 h-5" />
          {alertsCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-rose-600 text-white font-mono text-[10px] font-bold rounded-full flex items-center justify-center px-1 border-2 border-white animate-pulse">
              {alertsCount}
            </span>
          )}
        </div>
        <span className="text-[11px] mt-1">قائمة الشراء</span>
      </button>

      {/* Tab 3: Automatic Consumption Logs & Daily Records */}
      <button
        onClick={() => onTabChange('logs')}
        className={`flex-1 flex flex-col items-center justify-center py-1 rounded-2xl transition-all duration-200 relative ${
          activeTab === 'logs'
            ? 'text-teal-800 font-bold'
            : 'text-slate-500 hover:text-slate-800 font-medium'
        }`}
      >
        <div
          className={`px-4 py-1 rounded-full flex items-center justify-center transition ${
            activeTab === 'logs' ? 'bg-teal-100 text-teal-800' : 'bg-transparent'
          }`}
        >
          <History className="w-5 h-5" />
        </div>
        <span className="text-[11px] mt-1">سجل الاستهلاك</span>
      </button>
    </nav>
  );
};
