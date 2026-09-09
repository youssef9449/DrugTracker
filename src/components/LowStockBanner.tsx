import type { FC } from 'react';
import { AlertTriangle, AlertCircle, ShoppingBag, ShoppingCart } from 'lucide-react';
import { Medication, calculateMedicationStatus } from '../types';
import { getDepletionDate } from '../utils/dateCalculations';

interface LowStockBannerProps {
  medications: Medication[];
  onNavigateToShopping: () => void;
}

export const LowStockBanner: FC<LowStockBannerProps> = ({
  medications,
  onNavigateToShopping,
}) => {
  const lowStockMeds = medications.filter((m) => {
    const { status } = calculateMedicationStatus(m);
    return status === 'out_of_stock' || status === 'critical' || status === 'warning';
  });

  if (lowStockMeds.length === 0) {
    return (
      <div className="mx-4 mt-3 p-3.5 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center text-emerald-600">
            <ShoppingBag className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-emerald-900">مخزونك في أمان تام</h4>
            <p className="text-[11px] text-emerald-700">الاستهلاك اليومي يُخصم تلقائياً وكل أدويتك تكفي لفترة مريحة.</p>
          </div>
        </div>
      </div>
    );
  }

  const outOfStockCount = lowStockMeds.filter(
    (m) => calculateMedicationStatus(m).status === 'out_of_stock'
  ).length;

  return (
    <div
      className={`mx-4 mt-3 p-3.5 rounded-2xl border transition-all shadow-xs ${
        outOfStockCount > 0
          ? 'bg-rose-50 border-rose-200 text-rose-950'
          : 'bg-amber-50 border-amber-200 text-amber-950'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
              outOfStockCount > 0
                ? 'bg-rose-100 text-rose-600'
                : 'bg-amber-100 text-amber-600'
            }`}
          >
            {outOfStockCount > 0 ? (
              <AlertCircle className="w-5 h-5 animate-pulse" />
            ) : (
              <AlertTriangle className="w-5 h-5" />
            )}
          </div>
          <div>
            <h4 className="text-xs font-bold">
              {outOfStockCount > 0
                ? `تنبيه عاجل: ${outOfStockCount} دواء نفد مخزونه بالكامل!`
                : `تنبيه: ${lowStockMeds.length} أدوية اقتربت من النفاذ`}
            </h4>
            <p className="text-[11px] mt-0.5 opacity-90 leading-relaxed">
              بناءً على حساب الاستهلاك التلقائي، يُفضل شراء عبوات جديدة قريباً.
            </p>
          </div>
        </div>

        <button
          onClick={onNavigateToShopping}
          className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 transition active:scale-95 shadow-xs ${
            outOfStockCount > 0
              ? 'bg-rose-600 hover:bg-rose-700 text-white'
              : 'bg-amber-600 hover:bg-amber-700 text-white'
          }`}
        >
          <ShoppingCart className="w-3.5 h-3.5" />
          <span>فتح قائمة الشراء</span>
        </button>
      </div>

      {/* Pill tags with depletion dates */}
      <div className="mt-2.5 pt-2 border-t border-rose-200/50 flex flex-wrap gap-1.5">
        {lowStockMeds.map((med) => {
          const { status } = calculateMedicationStatus(med);
          const depletion = getDepletionDate(med);
          return (
            <span
              key={med.id}
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-lg font-medium ${
                status === 'out_of_stock'
                  ? 'bg-rose-200 text-rose-900 font-bold'
                  : 'bg-amber-100 text-amber-900'
              }`}
            >
              <span>{med.name}:</span>
              <span className="font-mono text-[10px]">
                {status === 'out_of_stock' ? 'نفد اليوم' : `ينفد ${depletion.formattedArabic}`}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
};
