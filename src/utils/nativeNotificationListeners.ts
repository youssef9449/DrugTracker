import {
  addNotificationActionPerformedListener,
  addNotificationReceivedListener,
} from './notificationRuntime';

type NotificationActionHandler =
  ((actionId: string, medicationId: string, doseId?: string) => void) | null;
type DoseReceivedHandler = ((medicationId: string, doseId?: string) => void) | null;

let notificationHandle: { remove: () => Promise<void> } | null = null;
let notificationActionHandle: { remove: () => Promise<void> } | null = null;
let notificationActionHandler: NotificationActionHandler = null;
let doseReceivedHandler: DoseReceivedHandler = null;

export function registerNotificationActionHandler(
  handler: NotificationActionHandler
): void {
  notificationActionHandler = handler;
}

export function registerDoseReceivedHandler(handler: DoseReceivedHandler): void {
  doseReceivedHandler = handler;
}

function splitDoseReminderIdentity(identity: string): {
  medicationId: string;
  doseId: string;
} | null {
  const separator = identity.indexOf('::');
  if (separator <= 0) return null;
  const medicationId = identity.slice(0, separator);
  const doseId = identity.slice(separator + 2);
  return medicationId && doseId ? { medicationId, doseId } : null;
}

export async function initNotificationListeners(): Promise<void> {
  try {
    notificationActionHandle = await addNotificationActionPerformedListener(
      (event) => {
        const namespace =
          typeof event.namespace === 'string' ? event.namespace : '';
        const identity =
          typeof event.identity === 'string' ? event.identity : '';
        const actionId =
          typeof event.actionId === 'string' ? event.actionId : '';

        if (namespace !== 'dose-reminder' || !actionId || !identity) return;
        const parsed = splitDoseReminderIdentity(identity);
        if (parsed && notificationActionHandler) {
          notificationActionHandler(actionId, parsed.medicationId, parsed.doseId);
        }
      }
    );
  } catch (err) {
    console.warn('[native] NotificationRuntime action listener failed:', err);
  }

  try {
    notificationHandle = await addNotificationReceivedListener(
      (event) => {
        const namespace =
          typeof event.namespace === 'string' ? event.namespace : '';
        const identity =
          typeof event.identity === 'string' ? event.identity : '';

        if (namespace !== 'dose-reminder' || !identity) return;
        const parsed = splitDoseReminderIdentity(identity);
        if (parsed && doseReceivedHandler) {
          try {
            doseReceivedHandler(parsed.medicationId, parsed.doseId);
          } catch (err) {
            console.warn('[native] doseReceivedHandler failed:', err);
          }
        }
      }
    );
  } catch (err) {
    console.warn('[native] NotificationRuntime received listener failed:', err);
  }
}

export async function cleanupNotificationListeners(): Promise<void> {
  try {
    if (notificationHandle) await notificationHandle.remove();
  } catch (err) {
    console.warn('[native] notificationHandle.remove() failed:', err);
  }
  try {
    if (notificationActionHandle) await notificationActionHandle.remove();
  } catch (err) {
    console.warn('[native] notificationActionHandle.remove() failed:', err);
  }
  notificationHandle = null;
  notificationActionHandle = null;
  notificationActionHandler = null;
  doseReceivedHandler = null;
}
