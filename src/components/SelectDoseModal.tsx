import type { FC } from 'react';
import { Check, Pill, X } from 'lucide-react';
import type { Medication, MedicationDose } from '../types';
import { formatTimeArabic } from '../types';
import {
  getTodayDateString,
  isDoseConsumedOnDate,
} from '../utils/dateCalculations';
import {
  relativeDoseDayLabel,
  sortDoseSelectItems,
} from '../utils/doseSelectDisplay';
import { Modal } from './ui/Modal';

export interface SelectDoseModalProps {
  isOpen: boolean;
  medication: Medication | null;
  onSelect: (medicationId: string, doseId: string) => void;
  onClose: () => void;
}

/**
 * Explicit multi-dose selection UI (Phase 3A).
 * Does not guess a dose — the user must pick a specific doseId.
 * Day + time labels are presentation only; selection still uses doseId.
 */
export const SelectDoseModal: FC<SelectDoseModalProps> = ({
  isOpen,
  medication,
  onSelect,
  onClose,
}) => {
  if (!medication) return null;

  const today = getTodayDateString();
  const schedule: MedicationDose[] = Array.isArray(medication.doseSchedule)
    ? medication.doseSchedule
    : [];
  // Manual consume targets today's slots; each row carries today's event date
  // so day labels and chronological order stay date-aware (not time-only).
  const items = sortDoseSelectItems(
    schedule.map((dose) => ({ dose, eventDate: today }))
  );
  const unit = medication.unit || 'قرص';
  const allConsumed =
    schedule.length > 0 &&
    schedule.every((d) => isDoseConsumedOnDate(medication, d.id, today));

  return (
    <Modal isOpen={isOpen} onClose={onClose} label="اختر الجرعة" variant="center">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-auto overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="flex items-center gap-2 min-w-0">
            <Pill className="w-5 h-5 text-emerald-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-800 truncate">
                {medication.name}
              </h2>
              <p className="text-xs text-slate-500">اختر الجرعة التي تناولتها</p>
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
          {allConsumed ? (
            <div className="text-center py-6 px-4">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-50 flex items-center justify-center">
                <Check className="w-6 h-6 text-emerald-600" />
              </div>
              <p className="text-sm font-bold text-emerald-700">
                تم تناول جميع جرعات اليوم
              </p>
            </div>
          ) : (
            items.map(({ dose, eventDate }) => {
              const consumed = isDoseConsumedOnDate(medication, dose.id, today);
              const dayLabel = relativeDoseDayLabel(eventDate, today);
              const timeLabel = formatTimeArabic(dose.time);
              const whenLabel = `${dayLabel} • ${timeLabel}`;
              const amountLabel = `${dose.amount} ${unit}`;
              const ariaLabel = consumed
                ? `تم تناول ${whenLabel} — ${amountLabel}`
                : `تناول ${whenLabel} — ${amountLabel}`;
              return (
                <button
                  key={dose.id}
                  type="button"
                  disabled={consumed}
                  onClick={() => {
                    if (consumed) return;
                    onSelect(medication.id, dose.id);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl border text-right transition active:scale-[0.99] ${
                    consumed
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700 cursor-not-allowed opacity-90'
                      : 'bg-white border-slate-200 hover:border-emerald-300 hover:bg-emerald-50 text-slate-800'
                  }`}
                  data-dose-id={dose.id}
                  data-event-date={eventDate}
                  aria-label={ariaLabel}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                        consumed
                          ? 'bg-emerald-500 border-emerald-500 text-white'
                          : 'border-slate-300 text-transparent'
                      }`}
                    >
                      {consumed ? <Check className="w-3 h-3" /> : null}
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
                  {!consumed && (
                    <span className="text-xs font-bold text-emerald-600 shrink-0">
                      اختيار
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
};
