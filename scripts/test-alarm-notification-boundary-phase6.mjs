/**
 * Structural regression checks for the Phase 6 Alarm Runtime / Notification Runtime boundary.
 * Run: node scripts/test-alarm-notification-boundary-phase6.mjs
 * No npm/npx required.
 *
 * Boundary:
 *   Exact Alarm Runtime = exact timing / durable alarm mechanics.
 *   Notification Runtime = notification presentation mechanics.
 *
 * Auto Deduction is an exact-alarm consumer only:
 *   Auto Exact Alarm -> AutoDeductionReceiver -> FIRED event
 * and must never enter the Notification Runtime boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

function listJavaFiles(relDir) {
  const dir = path.join(root, relDir);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.java'))
    .map((name) => path.join(relDir, name));
}

const autoJavaFiles = listJavaFiles('native-android/auto-deduction');
const alarmRuntimeJavaFiles = listJavaFiles('native-android/alarm-runtime');

const autoTsFiles = [
  'src/hooks/useAutoDeductionScheduler.ts',
  'src/hooks/useExactAutoDeductionReconciliation.ts',
  'src/hooks/useStartupAutoDeduction.ts',
  'src/utils/autoDeductionNative.ts',
  'src/utils/autoDeductionReconciliation.ts',
  'src/utils/autoDeductionScheduleOwnership.ts',
  'src/utils/autoDeductionStockGate.ts',
  'src/utils/runAutoDeductionReconciliation.ts',
];

const autoNotificationPatterns = [
  /^import .*notificationruntime\./m,
  /app\.drugtracker\.notificationruntime/i,
  /\bNotificationRuntime\b/,
  /\bNotificationManager\b/,
  /\bNotificationChannel\b/,
  /NotificationCompat/,
  /@capacitor\/local-notifications/,
  /\bnotificationId\s*\(/,
  /\bnotificationIds\b/,
  /scheduleNotification\s*\(/,
  /postNativeNotification\s*\(/,
  /cancelNativeNotification\s*\(/,
  /DOSE_REMINDER_CHANNEL_ID/,
  /DOSE_REMINDER_FOREGROUND_CHANNEL_ID/,
  /LOW_STOCK_CHANNEL_ID/,
  /channelId\s*[:=]/,
  /channelName\s*[:=]/,
  /["']dose-reminder(?:-[^"']*)?["']/,
  /["']low-stock["']/,
];

for (const rel of autoJavaFiles) {
  const content = read(rel);
  for (const pattern of autoNotificationPatterns) {
    assert(
      !pattern.test(content),
      'Auto production Java must not cross into notification presentation: '
        + rel
        + ' matches '
        + pattern
    );
  }
}

for (const rel of autoTsFiles) {
  const content = read(rel);
  for (const pattern of autoNotificationPatterns) {
    assert(
      !pattern.test(content),
      'Auto production TypeScript must not cross into notification presentation: '
        + rel
        + ' matches '
        + pattern
    );
  }
}

const alarmRuntimeDependencyPatterns = [
  /^import .*notificationruntime\./m,
  /app\.drugtracker\.notificationruntime/i,
  /\bNotificationRuntime\b/,
  /\bNotificationManager\b/,
  /\bNotificationChannel\b/,
  /NotificationCompat/,
  /@capacitor\/local-notifications/,
  /\bnotificationId\s*\(/,
  /\bnotificationIds\b/,
  /scheduleNotification\s*\(/,
  /postNativeNotification\s*\(/,
  /cancelNativeNotification\s*\(/,
  /DOSE_REMINDER_CHANNEL_ID/,
  /DOSE_REMINDER_FOREGROUND_CHANNEL_ID/,
  /LOW_STOCK_CHANNEL_ID/,
];

for (const rel of alarmRuntimeJavaFiles) {
  const content = read(rel);
  for (const pattern of alarmRuntimeDependencyPatterns) {
    assert(
      !pattern.test(content),
      'Shared Exact Alarm Runtime must remain notification-neutral: '
        + rel
        + ' matches '
        + pattern
    );
  }
}

const exactAlarmRuntime = read('native-android/alarm-runtime/ExactAlarmRuntime.java');
const exactAlarmStore = read('native-android/alarm-runtime/ExactAlarmStore.java');
const exactAlarmContract = read('native-android/alarm-runtime/ExactAlarmContract.java');
const exactAlarmLifecycle = read('native-android/alarm-runtime/ExactAlarmLifecycle.java');
const exactAlarmFeatureAdapter = read('native-android/alarm-runtime/ExactAlarmFeatureAdapter.java');

for (const [name, content] of [
  ['ExactAlarmRuntime', exactAlarmRuntime],
  ['ExactAlarmStore', exactAlarmStore],
  ['ExactAlarmContract', exactAlarmContract],
  ['ExactAlarmLifecycle', exactAlarmLifecycle],
  ['ExactAlarmFeatureAdapter', exactAlarmFeatureAdapter],
]) {
  assert(
    !/notificationruntime\./i.test(content)
      && !/\bNotificationRuntime\b/.test(content),
    name + ' must not depend on NotificationRuntime'
  );
}

const notificationRuntimeJavaFiles = listJavaFiles('native-android/notification-runtime');
for (const rel of notificationRuntimeJavaFiles) {
  const content = read(rel);
  assert(
    !/import android\.app\.AlarmManager;/m.test(content)
      && !/\bAlarmManager\b/.test(content)
      && !/\bExactAlarmRuntime\b/.test(content),
    'Notification Runtime must not own exact-alarm scheduling mechanics: '
      + rel
  );
}

const nativeJavaFiles = [
  ...listJavaFiles('native-android/alarm-runtime'),
  ...listJavaFiles('native-android/auto-deduction'),
  ...listJavaFiles('native-android/critical-stock'),
  ...listJavaFiles('native-android/dose-reminder'),
  ...notificationRuntimeJavaFiles,
];

const allowedFeatureNotificationReceivers = new Set([
  'native-android/dose-reminder/DoseReminderAlarmReceiver.java',
  'native-android/critical-stock/CriticalStockAlarmReceiver.java',
]);

for (const rel of nativeJavaFiles) {
  const content = read(rel);
  if (!/import app\.drugtracker\.notificationruntime\.NotificationRuntime;/m.test(content)) {
    continue;
  }
  assert(
    allowedFeatureNotificationReceivers.has(rel)
      || rel.startsWith('native-android/notification-runtime/'),
    'Only Dose/Critical delivery receivers may call NotificationRuntime: ' + rel
  );
}

const autoReceiver = read('native-android/auto-deduction/AutoDeductionReceiver.java');
assert(
  !autoReceiver.includes('NotificationRuntime'),
  'AutoDeductionReceiver must not depend on NotificationRuntime'
);
assert(
  autoReceiver.includes('exactAutoDeductionFired'),
  'AutoDeductionReceiver must continue emitting the Auto FIRED event to its business bridge'
);

const notificationIds = read('src/utils/notifications/notificationIds.ts');
assert(
  !/auto|autodeduction|exactauto/i.test(notificationIds),
  'Notification identity registry must contain no Auto Deduction category or identity'
);

const autoNativeBridge = read('src/utils/autoDeductionNative.ts');
assert(
  !/notifications\/|notificationRuntime|NotificationRuntime|notificationId\s*\(/i.test(autoNativeBridge),
  'Auto native TypeScript bridge must not import or address notification infrastructure'
);

console.log('PASS: Phase 6 Alarm Runtime / Notification Runtime boundary checks');
