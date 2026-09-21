/**
 * Compatibility facade for the public notification utility API.
 *
 * Implementations now live in small ownership-specific modules:
 * - notificationPermissions: permission/settings behavior
 * - notificationRuntime: logical notification identity + presentation mechanics
 * - notificationRuntime: shared notification mechanics
 * - stock/critical/dose notification modules: feature-facing presentation
 * - criticalAlarmScheduling / doseReminderScheduling: exact-alarm-side adapters
 *
 * This file intentionally contains no notification implementation.
 */

// Permission/settings API.
export {
  getNotificationPermission,
  requestNotificationPermission,
  openNotificationSettings,
} from './notifications/notificationPermissions';

// Feature-facing stock notification API.
export { sendMedicineAlert } from './notifications/stockNotifications';
export { sendCriticalStockAlert } from './notifications/criticalStockNotifications';

// Dose notification-facing API and channel state.
export {
  DOSE_REMINDER_CHANNEL_ID,
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
  setAppInForeground,
  isAppInForeground,
  getDoseReminderChannelId,
  sendTestAlertNotification,
  cancelSnoozedDoseReminder,
  scheduleSnoozedDoseReminder,
} from './notifications/doseReminderNotifications';

// Existing notification identity policy.
// Critical exact-alarm-side API.
export {
  cancelCriticalAlarm,
  verifyCriticalAlarmPending,
  scheduleCriticalAlarm,
} from './criticalAlarmScheduling';

// Dose exact-alarm-side API.
export {
  isDoseReminderPending,
  isNativeDoseReminderReArmed,
  cancelDoseReminder,
  cancelStaleDoseReminderAlarms,
  isDoseReminderTimeStillAhead,
  scheduleDoseReminder,
} from './doseReminderScheduling';
export type { ScheduleDoseReminderOptions } from './doseReminderScheduling';

// Exact-alarm capability is owned by Exact Alarm Runtime.
// Keep these legacy re-exports for existing consumers/tests; new production
// consumers should import them directly from ./exactAlarm.
export {
  getExactAlarmPermission,
  openExactAlarmSettings,
} from './exactAlarm';
