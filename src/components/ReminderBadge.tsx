import { Bell } from 'lucide-react';
import { Medication, formatTimeArabic } from '../types';
import { resolveSoundName } from './reminderBadgeHelpers';

/**
 * The "daily reminder + sound name" row shared by the three MedicationCard
 * render branches (alerts / sufficient / all). Extracted in L7 to
 * eliminate three near-duplicate copies.
 *
 * The row's accent color varies per branch, so the caller passes the
 * Tailwind classes via `containerClass`, `textClass`, and `badgeClass`.
 *
 * The "تجربة الصوت" test-sound button that was previously part of this
 * row was removed at the user's request — the test-sound action is still
 * available in the per-card dropdown menu (MedicationMenu) for the
 * views that enable `showTestSound`, and in the AppSettingsModal.
 */
interface ReminderBadgeProps {
  medication: Medication;
  containerClass: string;
  textClass: string;
  badgeClass: string;
  buttonClass?: string;
  onTriggerAlarm?: (medication: Medication) => void;
}

export function ReminderBadge({
  medication,
  containerClass,
  textClass,
  badgeClass,
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
      <span className={`text-[10px] px-1.5 py-0.2 rounded-md font-medium ${badgeClass}`}>
        {resolveSoundName(medication)}
      </span>
    </div>
  );
}
