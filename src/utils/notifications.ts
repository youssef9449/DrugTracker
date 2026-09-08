export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) {
    return false;
  }
  if (Notification.permission === 'granted') {
    return true;
  }
  if (Notification.permission !== 'denied') {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  }
  return false;
}

export function sendMedicineAlert(medicineName: string, daysLeft: number, currentPills: number) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  const title = `⚠️ تنبيه اقتراب نفاد: ${medicineName}`;
  const daysText =
    daysLeft === 1
      ? 'يوم واحد'
      : daysLeft === 2
      ? 'يومين'
      : daysLeft <= 10
      ? `${daysLeft} أيام`
      : `${daysLeft} يوماً`;

  const bodyText =
    currentPills <= 0
      ? `المخزون نفد تماماً (0 حبة). يرجى طلب الدواء وتعبئته فوراً!`
      : `المتبقي ${currentPills} حبة فقط، تكفي لـ ${daysText}. يرجى الشراء قريباً!`;

  const options: NotificationOptions = {
    body: bodyText,
    icon: '/icon.svg',
    tag: `med-${medicineName}`,
  };

  try {
    new Notification(title, options);
  } catch {
    // Service worker fallback or silent fail
  }
}

/**
 * Sends a browser notification for a scheduled daily dose reminder.
 * If `reminderTime` is provided, the time is included in the notification body
 * to remind the user of the exact scheduled time.
 */
export function sendMedicationDoseReminder(
  medicineName: string,
  dailyDose: number,
  unit: string = 'قرص',
  currentPills: number,
  reminderTime?: string
) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  const timeHint = reminderTime ? ` الساعة ${reminderTime}` : '';
  const title = `⏰ حان موعد دواء: ${medicineName}`;
  const bodyText = `موعد الجرعة${timeHint}. جرعتك المقررة: ${dailyDose} ${unit}. (المخزون الحالي: ${currentPills} ${unit}).`;

  const options: NotificationOptions = {
    body: bodyText,
    icon: '/icon.svg',
    tag: `dose-reminder-${medicineName}-${Date.now()}`,
  };

  try {
    new Notification(title, options);
  } catch {
    // Silent fail if permission or context blocked
  }
}

