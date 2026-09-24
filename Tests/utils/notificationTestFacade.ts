export {
  getNotificationPermission,
  requestNotificationPermission,
  openNotificationSettings,
} from '../../src/utils/notifications/notificationPermissions';

export { sendMedicineAlert } from '../../src/utils/notifications/stockNotifications';
export { sendCriticalStockAlert } from '../../src/utils/notifications/criticalStockNotifications';

export {
  DOSE_REMINDER_CHANNEL_ID,
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
  DOSE_REMINDER_TAKE_ACTION,
  setAppInForeground,
  isAppInForeground,
  getDoseReminderChannelId,
  sendTestAlertNotification,
  cancelSnoozedDoseReminder,
  scheduleSnoozedDoseReminder,
} from '../../src/utils/notifications/doseReminderNotifications';

export {
  cancelCriticalAlarm,
  verifyCriticalAlarmPending,
  scheduleCriticalAlarm,
} from '../../src/utils/criticalAlarmScheduling';

export {
  isDoseReminderPending,
  isNativeDoseReminderReArmed,
  cancelDoseReminder,
  cancelStaleDoseReminderAlarms,
  isDoseReminderTimeStillAhead,
  scheduleDoseReminder,
} from '../../src/utils/doseReminderScheduling';
export type { ScheduleDoseReminderOptions } from '../../src/utils/doseReminderScheduling';

export {
  getExactAlarmPermission,
  openExactAlarmSettings,
} from '../../src/utils/exactAlarm';
