import { Bell, Volume2 } from 'lucide-react';
import { Medication, formatTimeArabic } from '../types';
import { playNotificationSound } from '../utils/sound';
import { resolveSoundName } from './reminderBadgeHelpers';

/**
 * The "daily reminder + sound name + test-sound button" row shared by
 * the three MedicationCard render branches (alerts / sufficient / all).
 * Extracted in L7 to eliminate three near-duplicate copies.
 *
 * The row's accent color varies per branch, so the caller passes the
 * Tailwind classes via `containerClass`, `textClass`, `badgeClass`, and
 * `buttonClass`.
 */
interface ReminderBadgeProps {
  medication: Medication;
  containerClass: string;
  textClass: string;
  badgeClass: string;
  buttonClass: string;
  onTriggerAlarm?: (medication: Medication) => void;
}

export function ReminderBadge({
  medication,
  containerClass,
  textClass,
  badgeClass,
  buttonClass,
  onTriggerAlarm,
}: ReminderBadgeProps) {
  if (!medication.reminderEnabled || !medication.reminderTime) return null;

  const handleTest = () => {
    if (onTriggerAlarm) {
      onTriggerAlarm(medication);
    } else {
      playNotificationSound(medication.notificationSound || 'classic_chime');
    }
  };

  return (
    <div
      className={`p-2 rounded-xl border flex items-center justify-between text-xs flex-wrap gap-1 ${containerClass}`}
    >
      <div className={`flex items-center gap-1.5 ${textClass}`}>
        <Bell className="w-3.5 h-3.5 shrink-0" />
        <span className="font-bold text-[11px]">
          تنبيه يومي: {formatTimeArabic(medication.reminderTime)}
        </span>
        <span className={`text-[10px] px-1.5 py-0.2 rounded-md font-medium ${badgeClass}`}>
          {resolveSoundName(medication)}
        </span>
      </div>

      <button
        type="button"
        onClick={handleTest}
        className={`px-2 py-0.5 rounded-lg text-[11px] font-bold flex items-center gap-1 shrink-0 active:scale-95 transition ${buttonClass}`}
        title="تجربة صوت التنبيه"
      >
        <Volume2 className="w-3 h-3" />
        <span>تجربة الصوت</span>
      </button>
    </div>
  );
}
