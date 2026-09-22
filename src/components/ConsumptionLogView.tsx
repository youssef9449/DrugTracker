import { useState, type FC } from 'react';
import { Clock, ArrowUpRight, ArrowDownLeft, ChevronRight, ChevronLeft } from 'lucide-react';
import { Medication, ConsumptionLog } from '../types';
import { SegmentedButton } from './ui/SegmentedButton';
import { formatArabicDate, formatLogTime } from '../utils/medicationPresentation';
import { DAYS_PER_MONTH } from '../utils/time';
import { formatScheduledDoseBreakdown } from '../utils/medicationPackaging';

const LOGS_PER_PAGE = 15;

interface ConsumptionLogViewProps {
  medications: Medication[];
  logs: ConsumptionLog[];
  showToast: (message: string) => void;
}

/**
 * Daily scheduled dose *slots*.
 * Source of truth is doseSchedule length — never dailyDose fallback.
 * Slot totals are independent of Auto Deduction state.
 */
function scheduledDailySlots(med: Medication): number {
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) return 0;
  return med.doseSchedule.length;
}

/**
 * Consumption activity timeline (logs + scheduled-dose breakdown with pagination).
 * Dose restore controls were intentionally removed from this view;
 * restore remains available via MedicationCard + SelectDoseModal.
 * The showToast prop is retained for App wiring compatibility.
 */
export const ConsumptionLogView: FC<ConsumptionLogViewProps> = ({
  medications,
  logs,
}) => {
  const [scheduleMode, setScheduleMode] = useState<'monthly' | 'daily'>('monthly');
  const [currentPage, setCurrentPage] = useState<number>(1);

  const isDaily = scheduleMode === 'daily';

  const totalDailySlots = medications.reduce(
    (sum, med) => sum + scheduledDailySlots(med),
    0
  );
  const totalMonthlySlots = totalDailySlots * DAYS_PER_MONTH;
  const scheduleTotal = isDaily ? totalDailySlots : totalMonthlySlots;

  // Pagination calculations
  const totalLogs = logs.length;
  const totalPages = Math.max(1, Math.ceil(totalLogs / LOGS_PER_PAGE));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const startIndex = (safeCurrentPage - 1) * LOGS_PER_PAGE;
  const currentLogs = logs.slice(startIndex, startIndex + LOGS_PER_PAGE);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
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
              سجل الاستهلاك
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              متابعة جرعاتك المسجلة وحركات المخزون
            </p>
          </div>
        </div>

        {/* Scheduled-dose slot totals — based on doseSchedule regardless of Auto Deduction */} 
        <div className="mt-4 p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-slate-700 block">
              {isDaily ? 'الجرعات المجدولة يومياً' : 'الجرعات المجدولة شهرياً'}
            </span>

            <SegmentedButton<'monthly' | 'daily'>
              id="schedule-mode-toggle"
              size="sm"
              value={scheduleMode}
              onChange={setScheduleMode}
              options={[
                { value: 'monthly', label: 'الجرعة الشهرية' },
                { value: 'daily', label: 'الجرعة اليومية' },
              ]}
              aria-label="نوع تفاصيل الجرعات المجدولة"
            />
          </div>

          <div className="flex items-center justify-center py-2">
            <span className="text-3xl font-black text-teal-800 tabular-nums">
              {scheduleTotal}
            </span>
            <span className="text-xs text-slate-500 mr-2">
              {isDaily ? 'جرعة / يوم' : 'جرعة / شهر'}
            </span>
          </div>

          {/* Per-medication slot breakdown — based on doseSchedule regardless of Auto Deduction */}
          <div className="pt-2 border-t border-slate-200/70 space-y-1.5">
            {medications.length === 0 ? (
              <p className="text-xs text-slate-400 py-1">لا توجد أدوية مضافة حالياً.</p>
            ) : (
              <div className="space-y-1.5">
                {medications.map((med) => {
                  const formattedBreakdown = formatScheduledDoseBreakdown(med, isDaily);
                  return (
                    <div
                      key={med.id}
                      className="p-2.5 px-3 rounded-xl bg-white border border-slate-200/60 flex items-center justify-between text-xs gap-3 shadow-2xs"
                    >
                      <span className="font-bold text-slate-900 truncate">
                        {med.name}:
                      </span>
                      <span className="font-semibold text-teal-800 text-left shrink-0">
                        {formattedBreakdown}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity log */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs space-y-3">
        <h3 className="text-sm font-bold text-slate-800">سجل العمليات:</h3>

        {totalLogs === 0 ? (
          <p className="text-xs text-slate-400 py-6 text-center leading-relaxed">
            لا توجد سجلات بعد، ستظهر هنا عمليات الخصم والتعبئة والتغييرات على المخزون.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {currentLogs.map((log) => {
                const isIn = Number(log.amount) > 0;
                return (
                  <div
                    key={log.id}
                    className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50/80"
                  >
                    <div
                      className={`mt-0.5 w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        isIn
                          ? 'bg-emerald-50 text-emerald-600'
                          : 'bg-rose-50 text-rose-600'
                      }`}
                    >
                      {isIn ? (
                        <ArrowDownLeft className="w-4 h-4" />
                      ) : (
                        <ArrowUpRight className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-slate-900 truncate">
                          {log.medicationName}
                        </span>
                        <span
                          className={`text-sm font-black tabular-nums ${
                            isIn ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {isIn ? '+' : ''}
                          {log.amount}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                        {log.description}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-1">
                        {formatArabicDate(log.date)} · {formatLogTime(log.timestamp)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => handlePageChange(safeCurrentPage - 1)}
                  disabled={safeCurrentPage <= 1}
                  className="w-9 h-9 flex items-center justify-center rounded-full text-slate-600 disabled:opacity-30 hover:bg-slate-100 active:bg-slate-200 transition cursor-pointer"
                  aria-label="الصفحة السابقة"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <span className="text-xs font-semibold text-slate-600">
                  {safeCurrentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => handlePageChange(safeCurrentPage + 1)}
                  disabled={safeCurrentPage >= totalPages}
                  className="w-9 h-9 flex items-center justify-center rounded-full text-slate-600 disabled:opacity-30 hover:bg-slate-100 active:bg-slate-200 transition cursor-pointer"
                  aria-label="الصفحة التالية"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
