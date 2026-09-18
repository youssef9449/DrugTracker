import type { FC } from 'react';
import { Check, Pill, RotateCcw, X } from 'lucide-react';
import type { ConsumptionLog, Medication, MedicationDose } from '../types';
import { formatTimeArabic } from '../types';
import {
  getTodayDateString,
  isDoseConsumedOnDate,
  isDoseSkippedOnDate,
} from '../utils/dateCalculations';
import {
  isDoseCompletedToday,
  isDoseTimeElapsedToday,
  isMedicationAutoDeductActive,
} from '../utils/doseSchedule';
import {
  relativeDoseDayLabel,
  sortDoseSelectItems,
} from '../utils/doseSelectDisplay';
import {
  findActiveDeductionForOccurrence,
  getHistoricalRestoreDisplayAmount,
} from '../utils/medActions';
import { Modal } from './ui/Modal';

export type SelectDoseMode = 'take' | 'restore' | 'manage';

export interface SelectDoseModalProps {
  isOpen: boolean;
  medication: Medication | null;
  /**
   * take = pick a dose to consume (legacy path).
   * restore = pick a dose to undo (legacy path).
   * manage = unified multi-dose management (preferred for Card).
   */
  mode?: SelectDoseMode;
  /** Used by take/restore modes and as take action in manage mode. */
  onSelect: (medicationId: string, doseId: string) => void;
  /** Restore action in manage mode (falls back to onSelect if omitted). */
  onRestore?: (medicationId: string, doseId: string) => void;
  /** Global Auto-Deduction toggle (defaults to true). Effective auto state
   *  is isMedicationAutoDeductActive(medication, globalAutoDeductEnabled). */
  globalAutoDeductEnabled?: boolean;
  /** Durable stock logs used to classify source and show historical amounts. */
  logs?: ConsumptionLog[];
  onClose: () => void;
}

/**
 * Multi-dose selection / management UI.
 * Does not guess a dose — the user must pick a specific doseId.
 *
 * mode='manage' (Card default for multi-dose):
 *   Every dose is listed with status + the single available action
 *   (تناول الجرعة | استرجاع الجرعة) or disabled when not actionable.
 *
 * mode='take' / 'restore': legacy single-purpose selection (kept for
 *   callers that still pass those modes).
 */
export const SelectDoseModal: FC<SelectDoseModalProps> = ({
  isOpen,
  medication,
  mode = 'take',
  onSelect,
  onRestore,
  globalAutoDeductEnabled = true,
  logs = [],
  onClose,
}) => {
  if (!medication) return null;

  const today = getTodayDateString();
  const now = new Date();
  const schedule: MedicationDose[] = Array.isArray(medication.doseSchedule)
    ? medication.doseSchedule
    : [];
  const items = sortDoseSelectItems(
    schedule.map((dose) => ({ dose, eventDate: today }))
  );
  const unit = medication.unit || 'قرص';
  const isManage = mode === 'manage';
  const isRestore = mode === 'restore';
  const isAutoActive = isMedicationAutoDeductActive(medication, globalAutoDeductEnabled);

  const title =
    isManage
      ? 'إدارة الجرعات'
      : isRestore
        ? 'استرجاع جرعة'
        : 'اختر الجرعة';
  const subtitle = isManage
    ? 'اختر الإجراء المناسب لكل جرعة'
    : isRestore
      ? 'اختر الجرعة المراد استرجاعها'
      : 'اختر الجرعة التي تناولتها';

  // Empty state only for pure take/restore modes
  const allDone =
    !isManage &&
    schedule.length > 0 &&
    schedule.every((d) => {
      const completed = isDoseCompletedToday(medication, d, today, now);
      return isRestore ? !completed : completed;
    });

  const emptyMessage = isRestore
    ? 'لا توجد جرعات قابلة للاسترجاع اليوم'
    : 'تم تناول جميع جرعات اليوم';

  return (
    <Modal isOpen={isOpen} onClose={onClose} label={title} variant="center">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-auto overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="flex items-center gap-2 min-w-0">
            <Pill className="w-5 h-5 shrink-0 text-teal-600" />
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
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-50 flex items-center justify-center">
                <Check className="w-6 h-6 text-slate-500" />
              </div>
              <p className="text-sm font-bold text-slate-600">{emptyMessage}</p>
            </div>
          ) : (
            items.map(({ dose, eventDate }) => {
              const completed = isDoseCompletedToday(medication, dose, today, now);
              const skipped = isDoseSkippedOnDate(medication, dose.id, today);
              const consumed = isDoseConsumedOnDate(medication, dose.id, today);
              const activeDeduction = findActiveDeductionForOccurrence(
                logs,
                medication.id,
                dose.id,
                today
              );
              const isAutoConsumed =
                consumed && activeDeduction?.type === 'auto_daily';
              // Historical restore amount only from exact active deduction evidence.
              // Never invent from dose.amount / schedule (matches restoreDose fail-closed).
              const historicalAmount = getHistoricalRestoreDisplayAmount(
                logs,
                medication.id,
                dose.id,
                today
              );
              const scheduleAmount = Number(dose.amount) || 0;
              const elapsed = isDoseTimeElapsedToday(dose.time, now);
              // Pure auto: completed via elapsed projection, not manual consume, not skipped.
              // Projection-only restore remains valid; do not treat as confirmed log amount.
              const isPureAuto =
                completed && !consumed && !skipped && elapsed;
              const timeLabel = formatTimeArabic(dose.time);
              const dayLabel = relativeDoseDayLabel(eventDate, today);
              const whenLabel = `${dayLabel} • ${timeLabel}`;

              if (isManage) {
                // Effective Auto-Deduction state = isAutoActive (single source:
                // isMedicationAutoDeductActive). Auto OFF = manual mode; restored
                // doses become takeable again (Take ↔ Restore cycle, unbounded).
                // Auto ON = auto manages the dose; a restored/skipped dose waits
                // for auto to re-deduct when due (no manual Take offered).
                //
                // Per-dose contract:
                //   consumed (manual)            → تم التناول     + استرجاع الجرعة  (both auto states)
                //   Auto ON + auto-deducted      → تم الخصم تلقائيًا + استرجاع الجرعة
                //   Auto ON + future (!elapsed)  → لم يحن وقتها  (no action)
                //   Auto ON + restored/skipped   → لم يتم التناول (no action — auto re-handles)
                //   Auto OFF (any state incl.    → لم يتم التناول + تناول الجرعة
                //     future/restored) = manual    (user is the source of truth)
                // Actions always carry the exact dose.id + dose.amount from doseSchedule.
                let statusText: string;
                let action: 'take' | 'restore' | null;
                let actionLabel: string;

                if (isAutoConsumed) {
                  // Exact Auto reuses the consumption marker for idempotency;
                  // the durable auto_daily log preserves the true source.
                  statusText = 'تم الخصم تلقائيًا';
                  action = 'restore';
                  actionLabel = 'استرجاع الجرعة';
                } else if (consumed) {
                  // Manually consumed today (either auto state): allow Restore.
                  statusText = 'تم التناول';
                  action = 'restore';
                  actionLabel = 'استرجاع الجرعة';
                } else if (isAutoActive && isPureAuto) {
                  // Auto ON, elapsed + auto-deducted (not manual, not skipped).
                  statusText = 'تم الخصم تلقائيًا';
                  action = 'restore';
                  actionLabel = 'استرجاع الجرعة';
                } else if (isAutoActive && !elapsed) {
                  // Auto ON + future slot: not yet due, no action available.
                  statusText = 'لم يحن وقتها';
                  action = null;
                  actionLabel = '';
                } else if (isAutoActive && skipped) {
                  // Auto ON + restored/skipped: auto will re-deduct when due; no manual Take.
                  statusText = 'لم يتم التناول';
                  action = null;
                  actionLabel = '';
                } else {
                  // Auto OFF (any state: future, restored, previously-auto, never-taken)
                  // → manual mode, allow Take. Restored doses are takeable again.
                  // (Also covers Auto ON + elapsed-but-not-yet-deducted transient.)
                  statusText = 'لم يتم التناول';
                  action = 'take';
                  actionLabel = 'تناول الجرعة';
                }

                // Restore display amount only from evidence; Take uses schedule.
                const amountLabel =
                  action === 'restore'
                    ? historicalAmount != null
                      ? `${historicalAmount} ${unit}`
                      : unit
                    : `${scheduleAmount} ${unit}`;
                if (action === 'restore' && historicalAmount != null) {
                  actionLabel = `استرجاع الجرعة (+${historicalAmount})`;
                } else if (action === 'take' && scheduleAmount > 0) {
                  actionLabel = `تناول الجرعة (-${scheduleAmount})`;
                }

                return (
                  <div
                    key={dose.id}
                    className="w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl border border-slate-200 bg-white text-slate-800"
                    data-dose-row-dose-id={dose.id}
                    data-event-date={eventDate}
                    data-select-mode="manage"
                    data-dose-status={
                      isAutoConsumed || isPureAuto
                        ? 'auto'
                        : consumed
                          ? 'consumed'
                          : action === 'take'
                            ? 'pending'
                            : 'inactive'
                    }
                  >
                    <div className="min-w-0 text-right flex-1">
                      <span className="block text-sm font-semibold truncate">
                        {whenLabel}
                      </span>
                      <span className="block text-xs text-slate-500 truncate">
                        {amountLabel}
                      </span>
                      <span className="block text-[11px] font-medium text-slate-600 mt-0.5">
                        الحالة: {statusText}
                      </span>
                    </div>
                    {action ? (
                      <button
                        type="button"
                        data-dose-id={dose.id}
                        data-dose-action={action}
                        onClick={() => {
                          if (action === 'restore') {
                            (onRestore ?? onSelect)(medication.id, dose.id);
                          } else {
                            onSelect(medication.id, dose.id);
                          }
                        }}
                        className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition active:scale-95 ${
                          action === 'restore'
                            ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                            : 'bg-emerald-600 text-white hover:bg-emerald-700'
                        }`}
                      >
                        {action === 'restore' ? (
                          <span className="inline-flex items-center gap-1">
                            <RotateCcw className="w-3 h-3" />
                            {actionLabel}
                          </span>
                        ) : (
                          actionLabel
                        )}
                      </button>
                    ) : (
                      <span className="shrink-0 text-[11px] text-slate-400 font-medium px-2">
                        —
                      </span>
                    )}
                  </div>
                );
              }

              // Legacy take / restore list (single-purpose)
              // Restore list: evidence-only amount; take list: schedule amount.
              const amountLabel = isRestore
                ? historicalAmount != null
                  ? `${historicalAmount} ${unit}`
                  : unit
                : `${scheduleAmount} ${unit}`;
              const isSelectable = isRestore
                ? completed && !skipped
                : !completed;
              const isDone = !isSelectable;

              let ariaLabel: string;
              let statusLabel: string | null = null;
              if (isRestore) {
                if (isSelectable) {
                  ariaLabel = `استرجاع ${whenLabel} — ${amountLabel}`;
                  statusLabel = 'استرجاع';
                } else if (skipped) {
                  ariaLabel = `تم استرجاع ${whenLabel} — ${amountLabel}`;
                  statusLabel = 'تم الاسترجاع';
                } else {
                  ariaLabel = `غير قابلة للاسترجاع ${whenLabel} — ${amountLabel}`;
                  statusLabel = 'غير متاحة';
                }
              } else if (isDone) {
                ariaLabel = isAutoConsumed
                  ? `تم خصم ${whenLabel} تلقائياً — ${amountLabel}`
                  : consumed
                    ? `تم تناول ${whenLabel} — ${amountLabel}`
                    : `تم خصم ${whenLabel} تلقائياً — ${amountLabel}`;
                statusLabel =
                  isAutoConsumed || !consumed ? 'خصم تلقائي' : 'تم التناول';
              } else {
                ariaLabel = `تناول ${whenLabel} — ${amountLabel}`;
                statusLabel = 'اختيار';
              }

              return (
                <button
                  key={dose.id}
                  type="button"
                  disabled={isDone}
                  onClick={() => {
                    if (isDone) return;
                    if (isRestore) {
                      (onRestore ?? onSelect)(medication.id, dose.id);
                    } else {
                      onSelect(medication.id, dose.id);
                    }
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl border text-right transition active:scale-[0.99] ${
                    isDone
                      ? 'bg-slate-50 border-slate-200 text-slate-500 cursor-not-allowed opacity-90'
                      : 'bg-white border-slate-200 hover:border-emerald-300 hover:bg-emerald-50 text-slate-800'
                  }`}
                  data-dose-id={dose.id}
                  data-event-date={eventDate}
                  data-select-mode={mode}
                  aria-label={ariaLabel}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="w-5 h-5 rounded-full border border-slate-300 flex items-center justify-center shrink-0">
                      {isDone && !isRestore ? (
                        <Check className="w-3 h-3 text-emerald-600" />
                      ) : null}
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
                    <span className="text-[11px] font-medium shrink-0 text-slate-500">
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
