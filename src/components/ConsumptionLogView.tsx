import { useState, type FC } from 'react';
import { Plus, Clock, ShieldCheck, ArrowUpRight, ArrowDownLeft, RotateCcw } from 'lucide-react';
import { Medication, ConsumptionLog } from '../types';
import { getTodayDateString, formatArabicDate } from '../utils/dateCalculations';
import { MAX_LOG_ROWS, DAYS_PER_MONTH } from '../utils/time';

interface ConsumptionLogViewProps {
  medications: Medication[];
  logs: ConsumptionLog[];
  onRestoreDose: (medicationId: string, reason: string) => boolean;
  showToast: (message: string) => void;
}

export const ConsumptionLogView: FC<ConsumptionLogViewProps> = ({
  medications,
  logs,
  onRestoreDose,
  showToast,
}) => {
  const [selectedMedIdInput, setSelectedMedIdInput] = useState<string>(medications[0]?.id || '');
  const [skipReason, setSkipReason] = useState<string>('نسيان الجرعة');

  // Derive the effective selection: if the stored id no longer matches a
  // displayed medication (e.g. it was deleted), fall back to the first.
  // This replaces the previous useEffect that mutated selectedMedId while
  // it was in its own dependency array (audit issue #69) — a derived value
  // is simpler, has no stale-closure risk, and never thrashes.
  const selectedMedId = medications.some((m) => m.id === selectedMedIdInput)
    ? selectedMedIdInput
    : (medications[0]?.id || '');

  // #111: derived from the IIFE that was inline in the JSX — the
  // selected med object, or undefined when no meds exist.
  const selectedMed = medications.find((m) => m.id === selectedMedId);

  // Total monthly DOSES across all active meds.
  // A "جرعة" (dose) = one daily intake event, regardless of how many
  // pills it contains. Each active med (auto-deduct enabled, positive
  // dailyDose) is taken once per day → DAYS_PER_MONTH doses/month.
  //
  // The previous implementation summed `dailyDose * 30`, which is the
  // total PILLS/month — that's wrong for two reasons:
  //   1. The stat label is "جرعة / شهر" (doses/month), not pills/month.
  //      A med with dailyDose=2 taken once a day = 30 doses/month, not 60.
  //   2. Summing pills across different units (قرص + مل + كيس) is
  //      meaningless and produced an inflated, nonsensical number.
  const totalMonthlyDoses = medications.reduce(
    (acc, m) =>
      acc + (m.autoDeductEnabled !== false && m.dailyDose > 0 ? DAYS_PER_MONTH : 0),
    0
  );

  const handleSkipDose = () => {
    if (!selectedMedId) return;
    const med = medications.find((m) => m.id === selectedMedId);
    if (!med) return;

    const restored = onRestoreDose(selectedMedId, skipReason);
    if (restored) {
      showToast(`تم استرجاع جرعة (${med.dailyDose} ${med.unit}) إلى مخزون "${med.name}"`);
    }
  };

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
            <p className="text-xs text-slate-500">
              تتبع خصم الجرعات بمرور الأيام واسترجاع الجرعات المنسية
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

      {/* Smart Tool: "Didn't take dose today / restore dose" */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs">
        <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-2">
          <RotateCcw className="w-4 h-4 text-teal-600" />
          <span>لم تتناول جرعتك اليوم؟ (استرجاع الجرعة للمخزون)</span>
        </h3>
        <p className="text-[11px] text-slate-500 mb-3">
          بما أن التطبيق يخصم الجرعة تلقائياً بمرور اليوم، إذا كنت صائماً أو نسيت أخذ الدواء اليوم، يمكنك إعادة الجرعة للمخزون بسهولة:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              اختر الدواء:
            </label>
            <select
              value={selectedMedId}
              onChange={(e) => setSelectedMedIdInput(e.target.value)}
              aria-label="اختر الدواء"
              className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs focus:ring-1 focus:ring-teal-500"
            >
              {medications.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} (+{m.dailyDose} {m.unit})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
              السبب:
            </label>
            <select
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs focus:ring-1 focus:ring-teal-500"
            >
              <option value="نسيان الجرعة">نسيان الجرعة</option>
              <option value="صيام">صيام</option>
              <option value="توصية طبية مؤقتة">توصية طبية مؤقتة</option>
              <option value="أخرى">أخرى</option>
            </select>
          </div>
        </div>

        <button
          onClick={handleSkipDose}
          className="mt-3 w-full py-2 px-3 bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition active:scale-98"
        >
          <Plus className="w-3.5 h-3.5 text-teal-600" />
          <span>
            إعادة الجرعة المخصومة للمخزون{' '}
            {selectedMed ? `(+${selectedMed.dailyDose} ${selectedMed.unit})` : '(+1 جرعة)'}
          </span>
        </button>
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
