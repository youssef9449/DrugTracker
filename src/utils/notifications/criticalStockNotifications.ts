import { scheduleNotification } from '../notificationRuntime';

export async function sendCriticalStockAlert(
  medId: string,
  medicineName: string,
  daysLeft: number,
  currentPills: number,
  unit: string = 'قرص'
): Promise<boolean> {
  // Title reflects the actual situation: out of stock, or critical
  // with N days left (the critical threshold IS the user-configured
  // warningThresholdDays — see getCriticalThresholdDays).
  const daysWord =
    daysLeft === 1
      ? 'يوم واحد'
      : daysLeft === 2
      ? 'يومين'
      : daysLeft <= 10
      ? `${daysLeft} أيام`
      : `${daysLeft} يوماً`;

  const title =
    currentPills <= 0
      ? `🚨 ${medicineName}: نفد المخزون!`
      : `🚨 ${medicineName}: حرج — باقي ${daysWord}!`;

  const body =
    currentPills <= 0
      ? `المخزون نفد تماماً (0 ${unit}). يرجى طلب الدواء فوراً!`
      : `متبقي ${currentPills} ${unit} فقط من "${medicineName}"، تكفي لـ ${daysWord}. يرجى التعبئة فوراً!`;

  // Returns whether the notification was actually handed to the
  // platform. Callers (the foreground stock-alert fallback) must only
  // record "sent" state after a successful send.
  return scheduleNotification({
    namespace: 'critical-stock-immediate',
    identity: medId,
    title,
    body,
    channelId: 'low-stock',
    channelName: 'تنبيهات النفاذ',
    channelImportance: 4,
    smallIcon: 'ic_launcher',
  });
}

/**
 * Internal helper: schedule a notification on whichever platform
 * the app is running on. Falls back to the browser Notification API
 * when Capacitor isn't available.
 *
 * Android notification presentation is handled by Notification Runtime;
 * JS only supplies the feature's content and policy.
 */
