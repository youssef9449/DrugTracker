import { type FC } from 'react';
import { Clock, ShieldCheck, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { Medication, ConsumptionLog } from '../types';
import { getTodayDateString, formatArabicDate } from '../utils/dateCalculations';
import { MAX_LOG_ROWS, DAYS_PER_MONTH } from '../utils/time';

interface ConsumptionLogViewProps {
  medications: Medication[];
  logs: ConsumptionLog[];
  onRestoreDose: (medicationId: string, reason: string, doseId?: string) => boolean;
  showToast: (message: string) => void;
}

/**
 * Consumption / sync activity timeline.
 * Dose restore controls were intentionally removed from this view;
 * restore remains available via MedicationCard + SelectDoseModal.
 * Props onRestoreDose/showToast are retained for App wiring compatibility.
 */
export const ConsumptionLogView: FC<ConsumptionLogViewProps> = ({
  medications,
  logs,
}) => {
  // Total monthly DOSES across all active meds.
  // A "جرعة" (dose) = one daily intake event, regardless of how many
  // pills it contains. Each active med (auto-deduct enabled, positive
  // dailyDose) is taken once per day → DAYS_PER_MONTH doses/month.
  const totalMonthlyDoses = medications.reduce(
    (acc, m) =>
      acc + (m.autoDeductEnabled !== false && m.dailyDose > 0 ? DAYS_PER_MONTH : 0),
    0
  );

  return (
    <div className="p-4 space-y-4">
      {/* Header explanation card */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-teal-50 text-teal-700 flex items-center justify-center">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">
              سجل الاستهلاك التلقائي
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              ملخص المزامنة اليومية والجرعات المنسية
            </p>
          </div>
        </div>

        {/* Info Pill */}
        <div className="mt-3 p-3 bg-teal-50/70 border border-teal-100 rounded-xl text-xs text-teal-900 leading-relaxed flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" />
          <div>
            <strong>كيف يعمل النظام؟</strong> يحسب التطبيق فارق الأيام تلقائياً منذ آخر تحديث، ويخصم الجرعات بناءً على معدل استهلاكك اليومي فوراً دون الحاجة لتسجيل يدوي.
          </div>
        </div>

        {/* Monthly Estimate Stats */}
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
            <span className="text-[11px] text-slate-500 block">إجمالي جرعاتك الشهرية</span>
            <span className="text-lg font-extrabold font-mono text-teal-800">
              {totalMonthlyDoses}
            </span>
            <span className="text-[11px] text-slate-600 mr-1">جرعة / شهر</span>
          </div>

          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
            <span className="text-[11px] text-slate-500 block">تاريخ آخر مزامنة</span>
            <span className="text-sm font-bold text-slate-800 block mt-1">
              {formatArabicDate(getTodayDateString(), false)}
            </span>
          </div>
        </div>
      </div>

      {/* Activity Timeline list */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold text-slate-700 px-1">
          سجل العمليات والمزامنة الأخيرة:
        </h3>

        {logs.length === 0 ? (
          <div className="p-6 bg-white rounded-2xl text-center text-xs text-slate-400 border border-slate-200/80">
            لا توجد سجلات بعد، ستظهر هنا حركات الخصم التلقائي والتعبئة.
          </div>
        ) : (
          <div className="space-y-2">
            {logs.slice(0, MAX_LOG_ROWS).map((log) => {
              const isDeduction = log.amount < 0;
              return (
                <div
                  key={log.id}
                  className="bg-white rounded-xl border border-slate-200/80 p-3 flex items-center justify-between text-xs shadow-2xs"
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        isDeduction
                          ? 'bg-rose-50 text-rose-600'
                          : 'bg-emerald-50 text-emerald-600'
                      }`}
                    >
                      {isDeduction ? (
                        <ArrowDownLeft className="w-4 h-4" />
                      ) : (
                        <ArrowUpRight className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-800 text-xs">
                        {log.medicationName}
                      </h4>
                      <p className="text-[11px] text-slate-500">{log.description}</p>
                    </div>
                  </div>

                  <div className="text-left shrink-0">
                    <span
                      className={`font-mono font-bold text-xs ${
                        isDeduction ? 'text-rose-600' : 'text-emerald-600'
                      }`}
                    >
                      {log.amount > 0 ? `+${log.amount}` : log.amount}
                    </span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">
                      {formatArabicDate(log.date, false)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
