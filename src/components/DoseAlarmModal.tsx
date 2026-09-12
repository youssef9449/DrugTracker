import type { FC } from 'react';
import { Bell, Check, Clock, X } from 'lucide-react';
import { Medication, formatTimeArabic } from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import { Modal } from './ui/Modal';

interface DoseAlarmModalProps {
  isOpen: boolean;
  medication: Medication | null;
  /** Dose slot that triggered this alarm (Phase 2/3 notification extra). */
  doseId?: string | null;
  onTakeDose: (med: Medication, doseId?: string) => void;
  onSnooze: (med: Medication) => void;
  onDismiss: () => void;
}

export const DoseAlarmModal: FC<DoseAlarmModalProps> = ({
  isOpen,
  medication,
  doseId,
  onTakeDose,
  onSnooze,
  onDismiss,
}) => {
  const dose =
    medication && doseId && Array.isArray(medication.doseSchedule)
      ? medication.doseSchedule.find((d) => d.id === doseId)
      : undefined;
  const displayTime =
    dose?.time ?? medication?.reminderTime;
  const displayAmount = dose?.amount ?? medication?.dailyDose;
  const unit = medication?.unit ?? 'قرص';

  return (
    <Modal
      isOpen={isOpen && Boolean(medication)}
      onClose={onDismiss}
      label="تنبيه موعد الجرعة"
      variant="center"
    >
      {medication && (
      <div
        className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden border border-teal-200"
        dir="rtl"
      >
        <div className="bg-gradient-to-r from-teal-700 via-teal-800 to-emerald-800 p-5 text-white text-center relative overflow-hidden">
          <div className="absolute top-2 left-2">
            <button
              onClick={onDismiss}
              className="p-1.5 rounded-full text-teal-200 hover:text-white hover:bg-teal-700/50 transition"
              aria-label="إغلاق"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="w-16 h-16 rounded-2xl bg-white/10 border border-white/20 mx-auto flex items-center justify-center shadow-lg mb-3 animate-bounce">
            <Bell className="w-8 h-8 text-amber-300" />
          </div>

          <span className="inline-flex items-center gap-1 bg-amber-400/20 text-amber-200 border border-amber-300/30 px-3 py-0.5 rounded-full text-xs font-bold mb-1">
            <Clock className="w-3.5 h-3.5 text-amber-300" />
            <span>
              {displayTime
                ? `موعد الساعة: ${formatTimeArabic(displayTime)}`
                : 'تنبيه موعد الجرعة'}
            </span>
          </span>

          <h3 className="text-xl font-black tracking-tight text-white mt-1">حان الآن موعد الدواء!</h3>
        </div>

        <div className="p-5 space-y-4">
          <div
            className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center space-y-1.5"
            data-dose-id={doseId ?? undefined}
          >
            <div className="text-xs font-bold text-slate-500">اسم الدواء</div>
            <div className="text-lg font-black text-slate-900 leading-tight">{medication.name}</div>

            {dose ? (
              <div className="text-[11px] font-bold text-teal-700 pt-0.5">
                جرعة الساعة {formatTimeArabic(dose.time)}
              </div>
            ) : null}

            <div className="inline-flex items-center gap-1.5 bg-teal-100/80 text-teal-900 border border-teal-200 px-3 py-1 rounded-xl text-sm font-extrabold mt-1">
              <span>الجرعة المطلوبة:</span>
              <span className="font-mono text-base">{displayAmount}</span>
              <span>{unit}</span>
            </div>

            <div className="text-[11px] text-slate-500 pt-1">
              المخزون المتوفر لديك حالياً: {effectiveCurrentPills(medication)} {unit}
            </div>
          </div>

          <div className="space-y-2 pt-1">
            <button
              type="button"
              onClick={() => onTakeDose(medication, doseId ?? undefined)}
              className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition active:scale-98"
              data-testid="alarm-take-dose"
            >
              <Check className="w-4 h-4" />
              <span>تناولت الجرعة الآن</span>
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onSnooze(medication)}
                className="py-2.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98"
              >
                <Clock className="w-3.5 h-3.5 text-slate-500" />
                <span>تأجيل 10 دقائق</span>
              </button>

              <button
                type="button"
                onClick={onDismiss}
                className="py-2.5 px-3 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-xl font-bold text-xs transition active:scale-98"
              >
                إغلاق التنبيه
              </button>
            </div>
          </div>
        </div>
      </div>
      )}
    </Modal>
  );
};
