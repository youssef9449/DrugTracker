import { Medication } from '../types';
import { NOTIFICATION_SOUND_OPTIONS } from '../utils/sound';

/**
 * Resolve the human-readable name of a medication's notification sound.
 * Custom sound files are a GLOBAL setting (no per-med custom file), so
 * here we just map the synthesized sound id to its display name.
 *
 * Lives in its own module so both `MedicationCard` and `ReminderBadge`
 * can import it without a circular dependency.
 */
export function resolveSoundName(med: Medication): string {
  const soundId = med.notificationSound || 'classic_chime';
  return NOTIFICATION_SOUND_OPTIONS.find((s) => s.id === soundId)?.name || 'نغمة كلاسيكية';
}
