import type { FC } from 'react';
import { Check, Pill, X } from 'lucide-react';
import type { Medication, MedicationDose } from '../types';
import { formatTimeArabic } from '../types';
import {
  getTodayDateString,
  isDoseConsumedOnDate,
} from '../utils/dateCalculations';
import { isDoseCompletedToday } from '../utils/doseSchedule';
import {
  relativeDoseDayLabel,
  sortDoseSelectItems,
} from '../utils/doseSelectDisplay';
import { Modal } from './ui/Modal';

export type SelectDoseMode = 'take' | 'restore';

export interface SelectDoseModalProps {
  isOpen: boolean;
  medication: Medication | null;
  /** take = pick a dose to consume; restore = pick a dose to undo. */
  mode?: SelectDoseMode;
  onSelect: (medicationId: string, doseId: string) => void;
  onClose: () => void;
}

/**
 * Explicit multi-dose selection UI (Phase 3A).
 * Does not guess a dose — the user must pick a specific doseId.
 * Day + time labels are presentation only; selection still uses doseId.
 *
 * mode='take' (default): selectable = not completed today.
 * mode='restore': selectable = completed today (manual or auto), not yet restored.
 */
export const SelectDoseModal: FC<SelectDoseModalProps> = ({
  isOpen,
  medication,
  mode = 'take',
  onSelect,
  onClose,
}) => {
  if (!medication) return null;

  const today = getTodayDateString();
  const now = new Date();
  const schedule: MedicationDose[] = Array.isArray(medication.doseSchedule)
    ? medication.doseSchedule
    : [];
  // Manual consume/restore targets today's slots; each row carries today's event date
  // so day labels and chronological order stay date-aware (not time-only).
  const items = sortDoseSelectItems(
    schedule.map((dose) => ({ dose, eventDate: today }))
  );
  const unit = medication.unit || 'قرص';
  const isRestore = mode === 'restore';

  const allDone =
    schedule.length > 0 &&
    schedule.every((d) => {
      const completed = isDoseCompletedToday(medication, d, today, now);
      // Take: all completed → nothing left to take.
      // Restore: none completed → nothing left to restore.
      return isRestore ? !completed : completed;
    });

  const subtitle = isRestore
    ? 'اختر الجرعة المراد استرجاعها'
    : 'اختر الجرعة التي تناولتها';
  const emptyMessage = isRestore
    ? 'لا توجد جرعات قابلة للاسترجاع اليوم'
    : 'تم تناول جميع جرعات اليوم';
  const emptyTone = isRestore ? 'text-slate-600' : 'text-emerald-700';
  const emptyIconBg = isRestore ? 'bg-slate-50' : 'bg-emerald-50';
  const emptyIconColor = isRestore ? 'text-slate-500' : 'text-emerald-600';

  return (
    <Modal isOpen={isOpen} onClose={onClose} label="اختر الجرعة" variant="center">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-auto overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="flex items-center gap-2 min-w-0">
            <Pill
              className={`w-5 h-5 shrink-0 ${isRestore ? 'text-amber-600' : 'text-emerald-600'}`}
            />
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-800 truncate">
                {medication.name}
              </h2>
              <p className="text-xs text-slate-500">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-500"
            aria-label="إغلاق"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 space-y-2">
          {allDone ? (
            <div className="text-center py-6 px-4">
              <div
                className={`w-12 h-12 mx-auto mb-3 rounded-full ${emptyIconBg} flex items-center justify-center`}
              >
                <Check className={`w-6 h-6 ${emptyIconColor}`} />
              </div>
              <p className={`text-sm font-bold ${emptyTone}`}>{emptyMessage}</p>
            </div>
          ) : (
            items.map(({ dose, eventDate }) => {
              const completed = isDoseCompletedToday(medication, dose, today, now);
              // Take: disable completed. Restore: enable only completed.
              const isSelectable = isRestore ? completed : !completed;
              const isDone = !isSelectable;
              const consumed = isDoseConsumedOnDate(medication, dose.id, today);
              const dayLabel = relativeDoseDayLabel(eventDate, today);
              const timeLabel = formatTimeArabic(dose.time);
              const whenLabel = `${dayLabel} • ${timeLabel}`;
              const amountLabel = `${dose.amount} ${unit}`;

              let ariaLabel: string;
              let statusLabel: string | null = null;
              if (isRestore) {
                if (isSelectable) {
                  ariaLabel = `استرجاع ${whenLabel} — ${amountLabel}`;
                  statusLabel = 'استرجاع';
                } else {
                  ariaLabel = `غير قابلة للاسترجاع ${whenLabel} — ${amountLabel}`;
                  statusLabel = 'غير متاحة';
                }
              } else if (isDone) {
                ariaLabel = consumed
                  ? `تم تناول ${whenLabel} — ${amountLabel}`
                  : `تم خصم ${whenLabel} تلقائياً — ${amountLabel}`;
                statusLabel = consumed ? 'تم التناول' : 'خصم تلقائي';
              } else {
                ariaLabel = `تناول ${whenLabel} — ${amountLabel}`;
                statusLabel = 'اختيار';
              }

              const activeColor = isRestore
                ? 'hover:border-amber-300 hover:bg-amber-50'
                : 'hover:border-emerald-300 hover:bg-emerald-50';
              const actionColor = isRestore ? 'text-amber-600' : 'text-emerald-600';
              const doneBg = isRestore
                ? 'bg-slate-50 border-slate-200 text-slate-500 cursor-not-allowed opacity-90'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700 cursor-not-allowed opacity-90';
              const doneBadge = isRestore
                ? 'text-slate-500/80'
                : 'text-emerald-700/80';
              const checkBg = isRestore
                ? 'bg-slate-400 border-slate-400 text-white'
                : 'bg-emerald-500 border-emerald-500 text-white';

              return (
                <button
                  key={dose.id}
                  type="button"
                  disabled={isDone}
                  onClick={() => {
                    if (isDone) return;
                    onSelect(medication.id, dose.id);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl border text-right transition active:scale-[0.99] ${
                    isDone
                      ? doneBg
                      : `bg-white border-slate-200 ${activeColor} text-slate-800`
                  }`}
                  data-dose-id={dose.id}
                  data-event-date={eventDate}
                  data-select-mode={mode}
                  aria-label={ariaLabel}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                        isDone && !isRestore
                          ? checkBg
                          : isDone
                            ? 'border-slate-300 text-transparent'
                            : 'border-slate-300 text-transparent'
                      }`}
                    >
                      {isDone && !isRestore ? <Check className="w-3 h-3" /> : null}
                    </span>
                    <span className="min-w-0 text-right">
                      <span className="block text-sm font-semibold truncate">
                        {whenLabel}
                      </span>
                      <span className="block text-xs text-slate-500 truncate">
                        {amountLabel}
                      </span>
                    </span>
                  </span>
                  {statusLabel ? (
                    <span
                      className={`text-[11px] font-medium shrink-0 ${
                        isDone ? doneBadge : `text-xs font-bold ${actionColor}`
                      }`}
                    >
                      {statusLabel}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
};
