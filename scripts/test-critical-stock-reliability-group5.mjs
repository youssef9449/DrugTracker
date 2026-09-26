/**
 * Structural regression checks for Group 5 Critical Stock reliability.
 *
 * Run with plain Node; no npm/npx is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const receiver = read('native-android/critical-stock/CriticalStockAlarmReceiver.java');
const adapter = read('native-android/critical-stock/CriticalStockAlarmAdapter.java');
const exactAlarm = read('native-android/alarm-runtime/ExactAlarmRuntime.java');
const notification = read('native-android/notification-runtime/NotificationRuntime.java');
const scheduler = read('src/hooks/useCriticalAlarmScheduler.ts');
const foreground = read('src/hooks/useStockAlerts.ts');
const claims = read('src/utils/criticalNotificationClaims.ts');
const web = read('src/utils/notifications/webNotifications.ts');
const criticalScheduling = read('src/utils/criticalAlarmScheduling.ts');

assert(
  adapter.includes('deliveryState')
    && adapter.includes('completeOneShot(medicationId, operationVersion)')
    && adapter.includes('continue;'),
  'restore must not re-arm an already accepted one-shot delivery'
);
assert(
  receiver.includes('adapter.claimOneShotDelivery(')
    && receiver.includes('adapter.releaseOneShotDeliveryClaim(')
    && !receiver.includes('ExactAlarmRuntime.runWithOperationLock('),
  'Critical Stock delivery must claim ownership before notification I/O without holding the shared alarm lock'
);
assert(
  receiver.indexOf('adapter.claimOneShotDelivery(')
      < receiver.indexOf('new NotificationRuntime(appContext).post('),
  'stale Critical Stock delivery must be rejected before notification posting'
);
assert(
  receiver.includes('if (!postResult.accepted)'),
  'notification delivery failure must leave the one-shot durable'
);
assert(
  // Delivery-path ordering: the durable delivery evidence write happens
  // AFTER the notification post and BEFORE the one-shot completion that
  // consumes the schedule. The idempotent replay branch (an already-
  // delivered one-shot is completed early, before any posting) is the one
  // legitimate completeOneShot call that precedes markOneShotDelivered —
  // so the delivery-path completion is located with lastIndexOf.
  receiver.indexOf('adapter.markOneShotDelivered(')
      > receiver.indexOf('new NotificationRuntime(appContext).post(')
    && receiver.lastIndexOf('adapter.completeOneShot(')
      > receiver.indexOf('adapter.markOneShotDelivered('),
  'delivery evidence must be persisted before one-shot completion'
);
assert(
  exactAlarm.includes('public boolean claimOneShotDelivery(')
    && exactAlarm.includes('ACTIVE_DELIVERY_CLAIMS')
    && exactAlarm.includes('public boolean markOneShotDelivered(')
    && exactAlarm.includes('deliveryState')
    // The operation lock was unified into the shared runtime: evidence
    // writes are serialized on the OperationLock class monitor and guarded
    // by the operation-version ownership check before any durable write.
    && exactAlarm.includes('synchronized (OperationLock.class)')
    && exactAlarm.includes('isMetadataOwnedByOperationVersion'),
  'one-shot delivery evidence must be durable and operation-version guarded'
);
assert(
  notification.includes('if (!isChannelEnabled(request.channelId))')
    && notification.includes('notification_channel_disabled'),
  'blocked Android notification channels must be treated as delivery failure'
);
assert(
  scheduler.includes('updateCriticalNotificationClaim(')
    && !scheduler.includes('saveCriticalNotificationClaims(claims);'),
  'Critical scheduler claim writes must use the cross-tab failure-aware coordinator'
);
assert(
  scheduler.includes('current?.claimed && current.alarmTime === null')
    && scheduler.includes("exactAlarmPermission === 'denied'"),
  'scheduler must respect foreground in-flight ownership and permission-denied cleanup'
);
assert(
  foreground.includes('runWithCriticalNotificationClaim(')
    && foreground.includes('if (!sent)')
    && foreground.includes('releaseInFlightClaimIfOwned'),
  'foreground fallback must claim atomically and release on failed delivery'
);
assert(
  claims.includes('localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY)')
    && claims.includes('JSON.stringify(claims)'),
  'Critical Stock claim persistence must verify the write actually reached storage'
);
assert(
  criticalScheduling.includes("namespace: 'critical-stock'")
    && criticalScheduling.includes('identity: medId')
    && criticalScheduling.includes('at: fireAt'),
  'Web Critical Stock scheduling must retain namespace, identity, and exact crossing time'
);
assert(
  web.includes('if (!writeEntries(entries))')
    // #519: cancel reports failure when the durable state was unreadable —
    // the platform-level cancel still ran, but the caller must not treat
    // the state as trusted.
    && web.includes("return read.status === 'ok' && persisted && existed;"),
  'Web schedule/cancel persistence failures must be observable'
);

console.log('Group 5 Critical Stock reliability structural checks passed.');
