import { type FC } from 'react';
import { Clock, ShieldCheck, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { Medication, ConsumptionLog } from '../types';
import { formatArabicDate, formatLogTime } from '../utils/dateCalculations';
import { MAX_LOG_ROWS, DAYS_PER_MONTH } from '../utils/time';

interface ConsumptionLogViewProps {
  medications: Medication[];
  logs: ConsumptionLog[];
  showToast: (message: string) => void;
}

/**
 * Count daily dose *slots* for a medication under the current model.
 * Explicit doseSchedule only: length of the schedule when Auto is on.
 * Missing/empty doseSchedule → 0 (no dailyDose synthetic slot).
 * Medications with autoDeductEnabled === false contribute zero slots.
 */
function dailyScheduledSlots(med: Medication): number {
  if (med.autoDeductEnabled === false) return 0;
  if (med.doseSchedule && med.doseSchedule.length > 0) {
    return med.doseSchedule.length;
  }
  return 0;
}

/**
 * Consumption activity timeline (logs + scheduled-dose summary).
 * Dose restore controls were intentionally removed from this view;
 * restore remains available via MedicationCard + SelectDoseModal.
 * The showToast prop is retained for App wiring compatibility.
 */
export const ConsumptionLogView: FC<ConsumptionLogViewProps> = ({
  medications,
  logs,
}) => {
  // Sum of daily dose slots across auto-deduct medications, then × DAYS_PER_MONTH.
  // Explicit doseSchedule length only; no-schedule meds contribute 0.
  const totalDailyScheduled = medications.reduce(
    (acc, m) => acc + dailyScheduledSlots(m),
    0
  );
  const totalMonthlyDoses = totalDailyScheduled * DAYS_PER_MONTH;

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
              سجل الاستهلاك
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              متابعة جرعاتك المسجلة وحركات المخزون
            </p>
          </div>
        </div>

        {/* Info Pill */}
        <div className="mt-3 p-3 bg-teal-50/70 border border-teal-100 rounded-xl text-xs text-teal-900 leading-relaxed flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" />
          <div>
            <strong>كيف يعمل النظام؟</strong> يتم احتساب الجرعات المستحقة حسب مواعيد الجرعات المجدولة، وتظهر عمليات الخصم والتعبئة والتغييرات هنا تلقائياً.
          </div>
        </div>

        {/* Scheduled-dose summary stats */}
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
            <span className="text-[11px] text-slate-500 block">الجرعات المجدولة شهرياً</span>
            <span className="text-lg font-extrabold font-mono text-teal-800">
              {totalMonthlyDoses}
            </span>
            <span className="text-[11px] text-slate-600 mr-1">جرعة / شهر</span>
          </div>

          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
            <span className="text-[11px] text-slate-500 block">الجرعات المجدولة يومياً</span>
            <span className="text-lg font-extrabold font-mono text-teal-800 block mt-0.5">
              {totalDailyScheduled}
            </span>
            <span className="text-[11px] text-slate-600">جرعة / يوم</span>
          </div>
        </div>
      </div>

      {/* Activity Timeline list */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold text-slate-700 px-1">
          سجل العمليات:
        </h3>

        {logs.length === 0 ? (
          <div className="p-6 bg-white rounded-2xl text-center text-xs text-slate-400 border border-slate-200/80">
            لا توجد سجلات بعد، ستظهر هنا عمليات الخصم والتعبئة والتغييرات على المخزون.
          </div>
        ) : (
          <div className="space-y-2">
            {logs.slice(0, MAX_LOG_ROWS).map((log) => {
              const isDeduction = log.amount < 0;
              const logTime = formatLogTime(log.timestamp);
              return (
                <div
                  key={log.id}
                  className="bg-white rounded-xl border border-slate-200/80 p-3 flex items-center justify-between text-xs shadow-2xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
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
                    <div className="min-w-0">
                      <h4 className="font-bold text-slate-800 text-xs truncate">
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
                    {logTime ? (
                      <span className="text-[10px] text-slate-500 font-medium block mt-0.5" dir="rtl">
                        {logTime}
                      </span>
                    ) : null}
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
