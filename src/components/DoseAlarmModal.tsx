import type { FC } from 'react';
import { Bell, Check, Clock, Volume2, X } from 'lucide-react';
import { Medication, formatTimeArabic } from '../types';
import { NOTIFICATION_SOUND_OPTIONS, playNotificationSound } from '../utils/sound';

interface DoseAlarmModalProps {
  isOpen: boolean;
  medication: Medication | null;
  onTakeDose: (med: Medication) => void;
  onSnooze: (med: Medication) => void;
  onDismiss: () => void;
}

export const DoseAlarmModal: FC<DoseAlarmModalProps> = ({
  isOpen,
  medication,
  onTakeDose,
  onSnooze,
  onDismiss,
}) => {
  // #18/#19: the in-app chime is played by useDoseReminders.triggerAlarm
  // (gated by soundEnabled), which is the SINGLE source — this component
  // no longer plays a chime on mount. Previously it had a useEffect that
  // played the chime on the false→true opening transition, which (a)
  // duplicated the triggerAlarm chime (played twice) and (b) ignored the
  // soundEnabled flag. Both bugs are fixed by removing the useEffect.
  if (!isOpen || !medication) return null;

  const effectiveSoundType = medication.notificationSound || 'classic_chime';
  const currentSoundOption = NOTIFICATION_SOUND_OPTIONS.find(
    (s) => s.id === effectiveSoundType
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs">
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
              {medication.reminderTime
                ? `موعد الساعة: ${formatTimeArabic(medication.reminderTime)}`
                : 'تنبيه موعد الجرعة'}
            </span>
          </span>

          <h3 className="text-xl font-black tracking-tight text-white mt-1">حان الآن موعد الدواء!</h3>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center space-y-1.5">
            <div className="text-xs font-bold text-slate-500">اسم الدواء</div>
            <div className="text-lg font-black text-slate-900 leading-tight">{medication.name}</div>

            <div className="inline-flex items-center gap-1.5 bg-teal-100/80 text-teal-900 border border-teal-200 px-3 py-1 rounded-xl text-sm font-extrabold mt-1">
              <span>الجرعة المطلوبة:</span>
              <span className="font-mono text-base">{medication.dailyDose}</span>
              <span>{medication.unit}</span>
            </div>

            <div className="text-[11px] text-slate-500 pt-1">
              المخزون المتوفر لديك حالياً: {medication.currentPills} {medication.unit}
            </div>
          </div>

          <div className="flex items-center justify-between p-2.5 bg-amber-50/60 border border-amber-200/80 rounded-xl text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-lg shrink-0">{currentSoundOption?.icon || '🔔'}</span>
              <div className="min-w-0">
                <span className="text-slate-600">نغمة التنبيه: </span>
                <span className="font-bold text-amber-950 truncate inline-block max-w-[140px] align-bottom">
                  {currentSoundOption?.name || 'نغمة كلاسيكية'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                playNotificationSound(effectiveSoundType)
              }
              className="px-2.5 py-1 bg-white hover:bg-amber-100 border border-amber-300 rounded-lg text-xs font-bold text-amber-900 flex items-center gap-1 shadow-xs active:scale-95 transition shrink-0"
              title="إعادة الاستماع للنغمة"
            >
              <Volume2 className="w-3.5 h-3.5 text-amber-700" />
              <span>إعادة التشغيل</span>
            </button>
          </div>

          <div className="space-y-2 pt-1">
            <button
              type="button"
              onClick={() => onTakeDose(medication)}
              className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition active:scale-98"
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
    </div>
  );
};
