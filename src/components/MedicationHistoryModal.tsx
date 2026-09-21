import type { FC } from 'react';
import { History, X, ArrowUpRight, ArrowDownLeft, Minus } from 'lucide-react';
import type { ConsumptionLog, Medication } from '../types';
import { formatArabicDate, formatLogTime } from '../utils/dateCalculations';
import { Modal } from './ui/Modal';

interface MedicationHistoryModalProps {
  isOpen: boolean;
  medication: Medication | null;
  logs: ConsumptionLog[];
  onClose: () => void;
}

/**
 * History identity is medicationId only. Names are not unique and must
 * never decide which medication owns a log entry.
 */
export function filterLogsForMedication(
  logs: ConsumptionLog[],
  medicationId: string
): ConsumptionLog[] {
  return logs.filter((log) => log.medicationId === medicationId);
}

/**
 * Presentation class for a history amount:
 * - positive → increase (green)
 * - negative → deduction (rose)
 * - exact_auto with amount 0 → neutral (zero stock available; still a real occurrence)
 */
export function historyAmountPresentation(
  log: Pick<ConsumptionLog, 'type' | 'amount'>
): 'in' | 'out' | 'neutral' {
  const amount = Number(log.amount);
  if (log.type === 'exact_auto' && amount === 0) return 'neutral';
  if (amount > 0) return 'in';
  return 'out';
}

/** Format the signed amount text without producing "-0". */
export function formatHistoryAmountText(amount: number, unit: string): string {
  if (amount === 0) return `0 ${unit}`;
  if (amount > 0) return `+${amount} ${unit}`;
  return `${amount} ${unit}`;
}

export const MedicationHistoryModal: FC<MedicationHistoryModalProps> = ({
  isOpen,
  medication,
  logs,
  onClose,
}) => {
  if (!medication) return null;

  const medLogs = filterLogsForMedication(logs, medication.id);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      label={`سجل حركات ${medication.name}`}
      variant="sheet"
      closeOnBackdropClick
    >
      <div className="w-full max-w-lg mx-auto bg-white rounded-t-3xl sm:rounded-3xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/60 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
              <History className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900 truncate">
                سجل حركات: {medication.name}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                المتبقي الحالي: <span className="font-mono font-bold text-slate-800">{medication.currentPills}</span> {medication.unit}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 transition cursor-pointer"
            aria-label="إغلاق"
            title="إغلاق"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Logs List */}
        <div className="p-4 overflow-y-auto space-y-2 flex-1 min-h-[160px]">
          {medLogs.length === 0 ? (
            <div className="py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
                <History className="w-6 h-6 opacity-60" />
              </div>
              <p className="text-sm font-semibold text-slate-700">لا توجد حركات مسجلة</p>
              <p className="text-xs text-slate-400 mt-1">
                ستظهر هنا كل عمليات الخصم التلقائي، تناول الجرعات، وإعادة التعبئة والشراء لهذا الدواء.
              </p>
            </div>
          ) : (
            medLogs.map((log) => {
              const presentation = historyAmountPresentation(log);
              const amountNum = Number(log.amount);
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50/70"
                >
                  <div
                    className={`mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                      presentation === 'in'
                        ? 'bg-emerald-100/70 text-emerald-700'
                        : presentation === 'neutral'
                        ? 'bg-slate-200/80 text-slate-600'
                        : 'bg-rose-100/70 text-rose-700'
                    }`}
                  >
                    {presentation === 'in' ? (
                      <ArrowDownLeft className="w-3.5 h-3.5" />
                    ) : presentation === 'neutral' ? (
                      <Minus className="w-3.5 h-3.5" />
                    ) : (
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900 leading-snug">
                        {log.description}
                      </span>
                      <span
                        className={`text-xs font-black tabular-nums shrink-0 font-mono ${
                          presentation === 'in'
                            ? 'text-emerald-700'
                            : presentation === 'neutral'
                            ? 'text-slate-600'
                            : 'text-rose-700'
                        }`}
                      >
                        {formatHistoryAmountText(amountNum, medication.unit)}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1 font-medium">
                      {formatArabicDate(log.date)} · {formatLogTime(log.timestamp)}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-100 bg-slate-50/50 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-full bg-slate-200/80 text-slate-800 text-xs font-bold hover:bg-slate-300/80 transition cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </Modal>
  );
};
