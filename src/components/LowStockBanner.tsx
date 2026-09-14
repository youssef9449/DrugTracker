import type { FC } from 'react';
import { AlertTriangle, AlertCircle, ShoppingBag, ShoppingCart } from 'lucide-react';
import { MedicationWithStatus } from '../types';

interface LowStockBannerProps {
  medicationsWithStatus: MedicationWithStatus[];
  onNavigateToShopping: () => void;
}

export const LowStockBanner: FC<LowStockBannerProps> = ({
  medicationsWithStatus,
  onNavigateToShopping,
}) => {
  // Consume pre-computed status
  const lowStockMeds = medicationsWithStatus.filter(({ statusInfo }) =>
    statusInfo.status === 'out_of_stock' ||
    statusInfo.status === 'critical' ||
    statusInfo.status === 'warning'
  );

  if (lowStockMeds.length === 0) {
    return (
      <div className="mx-3 mt-2.5 p-3 bg-emerald-50/80 border border-emerald-200/70 rounded-2xl flex items-center justify-between shadow-2xs">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
            <ShoppingBag className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-emerald-950">المخزون في أمان</h4>
            <p className="text-[11px] text-emerald-700">جميع الأدوية تكفي لفترة كافية ولا توجد نواقص حالياً.</p>
          </div>
        </div>
      </div>
    );
  }

  const outOfStockCount = lowStockMeds.filter(
    ({ statusInfo }) => statusInfo.status === 'out_of_stock'
  ).length;

  const isUrgent = outOfStockCount > 0;

  return (
    <div
      className={`mx-3 mt-2.5 p-3 rounded-2xl border transition-all shadow-2xs ${
        isUrgent
          ? 'bg-rose-50/70 border-rose-200/80'
          : 'bg-amber-50/70 border-amber-200/80'
      }`}
    >
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
              isUrgent
                ? 'bg-rose-100 text-rose-700'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {isUrgent ? (
              <AlertCircle className="w-5 h-5 animate-pulse" />
            ) : (
              <AlertTriangle className="w-5 h-5" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h4 className="text-xs font-bold text-slate-900">
                {isUrgent
                  ? `${outOfStockCount} دواء نفد مخزونه بالكامل`
                  : `${lowStockMeds.length} أدوية اقتربت من النفاذ`}
              </h4>
              {isUrgent && lowStockMeds.length > outOfStockCount && (
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-rose-100/90 text-rose-800 shrink-0">
                  +{lowStockMeds.length - outOfStockCount} في خطر النفاذ
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-600 truncate mt-0.5">
              يُفضل طلب عبوات جديدة قريباً لضمان استمرارية العلاج
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onNavigateToShopping}
          className={`shrink-0 h-8 px-3.5 rounded-full text-xs font-bold flex items-center gap-1.5 transition-transform active:scale-95 shadow-2xs ${
            isUrgent
              ? 'bg-rose-600 hover:bg-rose-700 text-white'
              : 'bg-amber-600 hover:bg-amber-700 text-white'
          }`}
        >
          <ShoppingCart className="w-3.5 h-3.5" />
          <span>قائمة الشراء</span>
        </button>
      </div>
    </div>
  );
};
