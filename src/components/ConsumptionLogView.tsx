import { useState, type FC } from 'react';
import { Clock, ArrowUpRight, ArrowDownLeft, ChevronRight, ChevronLeft } from 'lucide-react';
import { Medication, ConsumptionLog } from '../types';
import { SegmentedButton } from './ui/SegmentedButton';
import { formatArabicDate, formatLogTime, dailyScheduleAmount } from '../utils/dateCalculations';
import { DAYS_PER_MONTH } from '../utils/time';
import { getMedSizes } from '../utils/medicationPackaging';
import { pluralizeArabic } from '../lib/arabicPlural';

const LOGS_PER_PAGE = 15;

interface ConsumptionLogViewProps {
  medications: Medication[];
  logs: ConsumptionLog[];
  showToast: (message: string) => void;
}

/**
 * Formats a medication's scheduled requirement (daily or monthly) into
 * natural packaging and unit counts, e.g.:
 * "علبتين (30 قرص)" or "علبة (10 أكياس)" or "قرص واحد".
 */
function formatMedicationScheduleBreakdown(med: Medication, isDaily: boolean): string {
  const dailyAmt = dailyScheduleAmount(med);
  const amount = isDaily ? dailyAmt : dailyAmt * DAYS_PER_MONTH;
  if (amount <= 0) {
    return '0 ' + med.unit;
  }

  const sz = getMedSizes(med);
  const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
  const boxSize = sz.boxSize > 0 ? sz.boxSize : (med.unit === 'مل' ? 100 : 30);

  // Natural Arabic unit count (e.g., "30 قرص", "10 أكياس", "قرص واحد", "قرصين")
  const getUnitDisplay = (count: number, unit: string) => {
    if (count === 1) {
      if (unit === 'قرص') return 'قرص واحد';
      if (unit === 'كبسولة') return 'كبسولة واحدة';
      if (unit === 'كيس') return 'كيس واحد';
      return `1 ${unit}`;
    }
    if (count === 2) {
      if (unit === 'قرص') return 'قرصين';
      if (unit === 'كبسولة') return 'كبسولتين';
      if (unit === 'كيس') return 'كيسين';
      return `2 ${unit}`;
    }
    if (count <= 10) {
      return pluralizeArabic(count, unit);
    }
    return `${count} ${unit}`;
  };

  const formattedUnit = getUnitDisplay(amount, med.unit);

  // If amount forms one or more boxes:
  if (amount >= boxSize) {
    const boxes = Math.floor(amount / boxSize);
    const remainder = amount % boxSize;

    let boxPart = '';
    if (boxes === 1) {
      boxPart = boxLabel;
    } else if (boxes === 2) {
      boxPart = boxLabel === 'علبة' ? 'علبتين' : 'عبوتين';
    } else if (boxes <= 10) {
      boxPart = `${boxes} ${boxLabel === 'علبة' ? 'علب' : 'عبوات'}`;
    } else {
      boxPart = `${boxes} ${boxLabel}`;
    }

    if (remainder === 0) {
      return `${boxPart} (${formattedUnit})`;
    }

    // Remainder exists: check if strips apply
    if (sz.hasStrips && sz.stripSize > 0) {
      const strips = Math.floor(remainder / sz.stripSize);
      const loose = remainder % sz.stripSize;
      const parts: string[] = [boxPart];
      if (strips === 1) parts.push('شريط');
      else if (strips === 2) parts.push('شريطين');
      else if (strips > 2) parts.push(`${strips} أشرطة`);
      if (loose > 0) parts.push(getUnitDisplay(loose, med.unit));

      return `${parts.join(' و ')} (${formattedUnit})`;
    }

    return `${boxPart} و ${getUnitDisplay(remainder, med.unit)} (${formattedUnit})`;
  }

  // If amount < boxSize, but can be expressed in strips:
  if (sz.hasStrips && sz.stripSize > 0 && amount >= sz.stripSize) {
    const strips = Math.floor(amount / sz.stripSize);
    const loose = amount % sz.stripSize;
    let stripPart = strips === 1 ? 'شريط' : strips === 2 ? 'شريطين' : `${strips} أشرطة`;
    if (loose > 0) {
      stripPart += ` و ${getUnitDisplay(loose, med.unit)}`;
    }
    return `${stripPart} (${formattedUnit})`;
  }

  // Under a box / strip:
  return formattedUnit;
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

        {/* Scheduled-dose breakdown card — full-width with Daily / Monthly toggle */}
        <div className="mt-4 p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-slate-700 block">
              تفاصيل الجرعات المجدولة ({isDaily ? 'الجرعة اليومية' : 'الجرعة الشهرية'})
            </span>

            {/* Toggle: Monthly vs Daily (M3 Segmented Button) */}
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

          {/* Breakdown per medication */}
          <div className="pt-2 border-t border-slate-200/70 space-y-1.5">
            {medications.length === 0 ? (
              <p className="text-xs text-slate-400 py-1">لا توجد أدوية مضافة حالياً.</p>
            ) : (
              <div className="space-y-1.5">
                {medications.map((med) => {
                  const breakdown = formatMedicationScheduleBreakdown(med, isDaily);
                  return (
                    <div
                      key={med.id}
                      className="p-2.5 px-3 rounded-xl bg-white border border-slate-200/60 flex items-center justify-between text-xs gap-3 shadow-2xs"
                    >
                      <span className="font-bold text-slate-900 truncate">
                        {med.name}:
                      </span>
                      <span className="font-semibold text-teal-800 text-left shrink-0">
                        {breakdown}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity Timeline list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-bold text-slate-700">
            سجل العمليات ({totalLogs}):
          </h3>
          {totalPages > 1 && (
            <span className="text-[11px] text-slate-500 font-medium">
              صفحة {safeCurrentPage} من {totalPages}
            </span>
          )}
        </div>

        {totalLogs === 0 ? (
          <div className="p-6 bg-white rounded-2xl text-center text-xs text-slate-400 border border-slate-200/80">
            لا توجد سجلات بعد، ستظهر هنا عمليات الخصم والتعبئة والتغييرات على المخزون.
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {currentLogs.map((log) => {
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

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="bg-white rounded-2xl border border-slate-200/80 p-3 shadow-xs mt-3">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => handlePageChange(safeCurrentPage - 1)}
                    disabled={safeCurrentPage <= 1}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    <ChevronRight className="w-4 h-4" />
                    <span>الأحدث</span>
                  </button>

                  <div className="text-xs font-bold text-slate-800 bg-slate-100 px-3 py-1.5 rounded-xl">
                    صفحة {safeCurrentPage} من {totalPages}
                  </div>

                  <button
                    type="button"
                    onClick={() => handlePageChange(safeCurrentPage + 1)}
                    disabled={safeCurrentPage >= totalPages}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    <span>الأقدم</span>
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
