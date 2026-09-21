import { scheduleNotification } from './notificationRuntime';
import { notificationId } from './notificationIds';

export async function sendMedicineAlert(
  medId: string,
  medicineName: string,
  daysLeft: number,
  currentPills: number
): Promise<void> {
  const title = `⚠️ تنبيه اقتراب نفاذ: ${medicineName}`;
  const daysText =
    daysLeft === 1
      ? 'يوم واحد'
      : daysLeft === 2
      ? 'يومين'
      : daysLeft <= 10
      ? `${daysLeft} أيام`
      : `${daysLeft} يوماً`;

  const body =
    currentPills <= 0
      ? `المخزون نفد تماماً (0 حبة). يرجى طلب الدواء وتعبئته فوراً!`
      : `المتبقي ${currentPills} حبة فقط، تكفي لـ ${daysText}. يرجى الشراء قريباً!`;

  await scheduleNotification({
    id: notificationId('lowStock', medId),
    namespace: 'low-stock',
    identity: medId,
    title,
    body,
    channelId: 'low-stock',
    smallIcon: 'ic_launcher',
  });
}

/**
 * Send a "critical stock" notification — fires when a medication
 * crosses the critical threshold (derived from warningThresholdDays).
 * The notification is more urgent than sendMedicineAlert because the
 * medication will run out within the critical window.
 *
 * This is the headline feature of the app — the user explicitly
 * requested it: "عايز اشعار يظهر لو في دواء فاضل فيه حبايتين مع
 * الاوبشن اني افعل الموضوع دة او اقفله".
 *
 * The notification can be turned off via the
 * `criticalStockAlertsEnabled` toggle in AppHeader. The caller is
 * responsible for checking the toggle before calling this function.
 *
 * @param medId Stable medication id — used to derive a unique
 *   notification id (avoids collisions with same-named medications).
 * @param medicineName The medication name (in the title)
 * @param daysLeft Days of supply remaining (drives the urgency wording)
 * @param currentPills Current pill count (in the body)
 * @param unit Unit (e.g., 'قرص', 'كبسولة')
 */
