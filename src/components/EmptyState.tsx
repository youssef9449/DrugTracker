import type { FC } from 'react';
import { Pill, Plus, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';

interface EmptyStateProps {
  hasSearch: boolean;
  onClearSearch: () => void;
  filter?: 'all' | 'alerts' | 'sufficient';
  onFilterChange?: (filter: 'all' | 'alerts' | 'sufficient') => void;
  onOpenAddModal: () => void;
}

export const EmptyState: FC<EmptyStateProps> = ({
  hasSearch,
  onClearSearch,
  filter = 'all',
  onFilterChange,
  onOpenAddModal,
}) => {
  // If search query is active
  if (hasSearch) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center bg-white rounded-3xl border border-dashed border-slate-300 m-2 shadow-2xs">
        <div className="w-14 h-14 rounded-2xl bg-teal-50 text-teal-600 flex items-center justify-center mb-3">
          <Pill className="w-7 h-7 rotate-45" />
        </div>
        <h3 className="text-base font-bold text-slate-800">لا توجد نتائج مطابقة للبحث</h3>
        <p className="text-xs text-slate-500 mt-1 max-w-xs leading-relaxed">
          تأكد من كتابة اسم الدواء أو التصنيف بالشكل الصحيح أو اضغط مسح للعودة للقائمة.
        </p>
        <button
          onClick={onClearSearch}
          className="mt-4 px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold rounded-xl transition shadow-xs"
        >
          مسح البحث وعرض الأدوية
        </button>
      </div>
    );
  }

  // Filter: 'alerts' (Running Low) has no low stock medicines!
  if (filter === 'alerts') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center bg-emerald-50/60 rounded-3xl border border-emerald-200 m-2 shadow-2xs">
        <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center mb-3">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h3 className="text-base font-bold text-emerald-950">
          رائع! لا توجد أدوية قاربت على النفاذ
        </h3>
        <p className="text-xs text-emerald-700 mt-1.5 max-w-xs leading-relaxed">
          كافة أدويتك الحالية تتوفر بكميات آمنة وكافية لأكثر من أسبوع بناءً على معدل استهلاكك التلقائي.
        </p>
        {onFilterChange && (
          <button
            onClick={() => onFilterChange('all')}
            className="mt-4 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 transition shadow-xs"
          >
            <span>عرض جميع الأدوية</span>
            <ArrowRight className="w-3.5 h-3.5 rotate-180" />
          </button>
        )}
      </div>
    );
  }

  // Filter: 'sufficient' has no safe medicines (all are low or empty)
  if (filter === 'sufficient') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center bg-amber-50/70 rounded-3xl border border-amber-200 m-2 shadow-2xs">
        <div className="w-14 h-14 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center mb-3">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <h3 className="text-base font-bold text-amber-950">
          لا توجد أدوية بمخزون كافٍ حالياً
        </h3>
        <p className="text-xs text-amber-800 mt-1.5 max-w-xs leading-relaxed">
          جميع أدويتك المسجلة حالياً وصلت إلى حد التنبيه أو قاربت على الانتهاء وتحتاج إلى إعادة تعبئة.
        </p>
        {onFilterChange && (
          <button
            onClick={() => onFilterChange('alerts')}
            className="mt-4 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 transition shadow-xs"
          >
            <span>مراجعة الأدوية التي قاربت على النفاذ</span>
            <ArrowRight className="w-3.5 h-3.5 rotate-180" />
          </button>
        )}
      </div>
    );
  }

  // Filter: 'all' (No medications in system)
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center bg-white rounded-3xl border border-dashed border-slate-300 m-2 shadow-2xs">
      <div className="w-14 h-14 rounded-2xl bg-teal-50 text-teal-600 flex items-center justify-center mb-3">
        <Pill className="w-7 h-7 rotate-45" />
      </div>
      <h3 className="text-base font-bold text-slate-800">لا توجد أدوية مسجلة حالياً</h3>
      <p className="text-xs text-slate-500 mt-1 max-w-xs leading-relaxed">
        أضف أدويتك اليومية مع عدد الحبوب ومعدل استهلاكك لنقوم بحساب وقت النفاذ وتنبيهك تلقائياً بمرور الأيام.
      </p>
      <button
        onClick={onOpenAddModal}
        className="mt-4 px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 transition shadow-xs"
      >
        <Plus className="w-4 h-4" />
        <span>أضف أول دواء الآن</span>
      </button>
    </div>
  );
};

