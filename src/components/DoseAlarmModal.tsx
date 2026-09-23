import type { FC } from 'react';
import { Bell, Check, Clock, X } from 'lucide-react';
import type { Medication } from '../types';
import { formatTimeArabic } from '../utils/medicationPresentation';
import { Modal } from './ui/Modal';

interface DoseAlarmModalProps {
  isOpen: boolean;
  medication: Medication | null;
  /** Explicit dose slot that triggered this alarm (required occurrence identity). */
  doseId: string;
  onTakeDose: (med: Medication, doseId: string) => void;
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
  const normalizedDoseId = typeof doseId === 'string' ? doseId.trim() : '';
  const dose =
    medication &&
    normalizedDoseId &&
    Array.isArray(medication.doseSchedule)
      ? medication.doseSchedule.find((d) => d && d.id === normalizedDoseId)
      : undefined;
  // Explicit schedule row only — no reminderTime/dailyDose synthetic fallback.
  const displayTime = dose?.time;
  const displayAmount = dose != null ? Number(dose.amount) : undefined;
  const unit = medication?.unit ?? 'قرص';
  const canInteract = Boolean(medication && dose && normalizedDoseId);

  return (
    <Modal
      isOpen={isOpen && Boolean(medication) && Boolean(normalizedDoseId)}
      onClose={onDismiss}
      label="تنبيه موعد الجرعة"
      variant="center"
    >
      {medication && canInteract && (
      <div
        className="w-full max-w-sm bg-white rounded-[28px] shadow-xl overflow-hidden border border-slate-200/80"
        dir="rtl"
      >
        <div className="bg-gradient-to-r from-teal-700 via-teal-800 to-emerald-800 p-5 text-white text-center relative overflow-hidden">
          <div className="absolute top-2 left-2">
            <button
              onClick={onDismiss}
              className="w-10 h-10 rounded-full text-teal-200 hover:text-white hover:bg-teal-700/50 transition flex items-center justify-center cursor-pointer"
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
            data-dose-id={normalizedDoseId}
          >
            <div className="text-xs font-bold text-slate-500">اسم الدواء</div>
            <div className="text-lg font-black text-slate-900 leading-tight">{medication.name}</div>

            {dose ? (
              <div className="text-[11px] font-bold text-teal-700 pt-0.5">
                جرعة الساعة {formatTimeArabic(dose.time)}
                {dose.description ? ` (${dose.description})` : ''}
              </div>
            ) : null}

            <div className="inline-flex items-center gap-1.5 bg-teal-100/80 text-teal-900 border border-teal-200 px-3 py-1 rounded-xl text-sm font-extrabold mt-1">
              <span>الجرعة المطلوبة:</span>
              <span className="font-mono text-base">{displayAmount}</span>
              <span>{unit}</span>
            </div>

            <div className="text-[11px] text-slate-500 pt-1">
              المخزون المتوفر لديك حالياً: {medication.currentPills} {unit}
            </div>
          </div>

          <div className="space-y-2.5 pt-1">
            <button
              type="button"
              onClick={() => onTakeDose(medication, normalizedDoseId)}
              className="w-full h-11 px-6 bg-teal-700 hover:bg-teal-800 active:bg-teal-900 text-white rounded-full font-semibold text-sm flex items-center justify-center gap-2 shadow-xs transition active:scale-98 cursor-pointer"
              data-testid="alarm-take-dose"
            >
              <Check className="w-4 h-4 stroke-[2.5]" />
              <span>تناولت الجرعة الآن</span>
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onSnooze(medication)}
                className="h-10 px-3 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-800 rounded-full font-semibold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 cursor-pointer"
              >
                <Clock className="w-3.5 h-3.5 text-slate-500" />
                <span>تأجيل 10 دقائق</span>
              </button>

              <button
                type="button"
                onClick={onDismiss}
                className="h-10 px-3 bg-white border border-slate-300 hover:bg-slate-50 active:bg-slate-100 text-slate-700 rounded-full font-semibold text-xs flex items-center justify-center transition active:scale-98 cursor-pointer"
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
