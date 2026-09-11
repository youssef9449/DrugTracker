import { Bell } from 'lucide-react';
import { Medication, formatTimeArabic } from '../types';

/**
 * The "daily reminder" row shared by the three MedicationCard render
 * branches (alerts / sufficient / all). Shows the reminder time.
 *
 * The per-medication sound name badge and the "تجربة الصوت" button were
 * removed — the dose reminder now uses a single native channel sound
 * with no per-medication customization.
 */
interface ReminderBadgeProps {
  medication: Medication;
  containerClass: string;
  textClass: string;
  badgeClass?: string;
  buttonClass?: string;
  onTriggerAlarm?: (medication: Medication) => void;
}

export function ReminderBadge({
  medication,
  containerClass,
  textClass,
}: ReminderBadgeProps) {
  if (!medication.reminderEnabled || !medication.reminderTime) return null;

  return (
    <div
      className={`p-2 rounded-xl border flex items-center gap-1.5 text-xs flex-wrap ${containerClass}`}
    >
      <Bell className="w-3.5 h-3.5 shrink-0" />
      <span className={`font-bold text-[11px] ${textClass}`}>
        تنبيه يومي: {formatTimeArabic(medication.reminderTime)}
      </span>
    </div>
  );
}
