import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

function javaFiles(relDir) {
  return fs.readdirSync(path.join(root, relDir))
    .filter((name) => name.endsWith('.java'))
    .map((name) => path.join(relDir, name));
}

assert(!exists('src/utils/notifications/notificationIds.ts'),
  'obsolete notification numeric-ID registry must be deleted');
assert(!exists('src/utils/notifications/notificationRuntime.ts'),
  'obsolete notification runtime wrapper must be deleted');
assert(!exists('src/utils/exactAlarmLegacyCleanup.ts'),
  'pre-Phase-6 numeric alarm migration cleanup must be deleted');
assert(exists('src/utils/notificationRuntime.ts'),
  'shared Notification Runtime implementation must remain present');

const runtime = read('src/utils/notificationRuntime.ts');
const runtimeInterfaceStart = runtime.indexOf('export interface NotificationRuntimePostOptions');
const runtimeInterfaceEnd = runtime.indexOf('\n}', runtimeInterfaceStart);
assert(runtimeInterfaceStart >= 0 && runtimeInterfaceEnd > runtimeInterfaceStart,
  'NotificationRuntimePostOptions interface must exist');
const runtimeInterface = runtime.slice(runtimeInterfaceStart, runtimeInterfaceEnd + 2);
assert(runtimeInterface.includes('namespace: string;') && runtimeInterface.includes('identity: string;'),
  'Notification Runtime API must require logical namespace + identity');
assert(!/\bid:\s*number\b/.test(runtimeInterface),
  'Notification Runtime feature contract must not expose numeric ids');
assert((runtime.match(/function iosPlatformNotificationId\(/g) || []).length === 1,
  'iOS platform numeric conversion must have exactly one private implementation');
assert(!runtime.includes('DOSE_REMINDER_CHANNEL_ID')
  && !runtime.includes('DOSE_REMINDER_FOREGROUND_CHANNEL_ID')
  && !runtime.includes('LOW_STOCK_CHANNEL_ID'),
  'Notification Runtime must remain free of feature-specific channel registries');
assert(!runtime.includes('NOTIFICATION_ID_BASE') && !runtime.includes('ID_RANGE_SIZE')
  && !runtime.includes('hashToRange'),
  'old category/range/hash allocator machinery must not remain in Notification Runtime');

function sourceFiles(relDir) {
  const dir = path.join(root, relDir);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...sourceFiles(rel));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push(rel);
    }
  }
  return result;
}

const obsoleteIdentityTokens = [
  'notificationId(',
  'notificationIds',
  'NOTIFICATION_ID_BASE',
  'ID_RANGE_SIZE',
  'hashToRange',
  'iosCriticalAlarmId',
  'doseReminderAlarmIdForDose',
  'snoozeDoseReminderId',
];

for (const rel of sourceFiles('src')) {
  if (rel === 'src/utils/notificationRuntime.ts') continue;
  const content = read(rel);
  for (const token of obsoleteIdentityTokens) {
    assert(
      !content.includes(token),
      'Production source must not retain obsolete notification identity machinery: '
        + rel
        + ' contains '
        + token
    );
  }
}

const featureFiles = [
  'src/utils/notifications/stockNotifications.ts',
  'src/utils/notifications/criticalStockNotifications.ts',
  'src/utils/notifications/doseReminderNotifications.ts',
  'src/utils/doseReminderScheduling.ts',
  'src/utils/criticalAlarmScheduling.ts',
];
for (const rel of featureFiles) {
  const content = read(rel);
  for (const token of [
    'notificationId(',
    'notificationIds',
    'NOTIFICATION_ID_BASE',
    'ID_RANGE_SIZE',
    'hashToRange',
    'iosCriticalAlarmId',
    'doseReminderAlarmIdForDose',
    'snoozeDoseReminderId',
  ]) {
    assert(!content.includes(token),
      rel + ' must not depend on obsolete numeric notification identity machinery: ' + token);
  }
}

assert(read('src/utils/notifications/stockNotifications.ts').includes("import { scheduleNotification } from '../notificationRuntime';"),
  'stock notification feature must call the shared Notification Runtime directly');
assert(read('src/utils/notifications/criticalStockNotifications.ts').includes("import { scheduleNotification } from '../notificationRuntime';"),
  'critical notification feature must call the shared Notification Runtime directly');
assert(read('src/utils/notifications/doseReminderNotifications.ts').includes("from '../notificationRuntime';"),
  'dose notification feature must call the shared Notification Runtime directly');
assert(read('src/utils/doseReminderScheduling.ts').includes("from './notificationRuntime';"),
  'dose scheduling must use the shared Notification Runtime boundary');
assert(read('src/utils/criticalAlarmScheduling.ts').includes("from './notificationRuntime';"),
  'critical scheduling must use the shared Notification Runtime boundary');

const nativeBridge = read('src/native.ts');
assert(!nativeBridge.includes('clearLegacyScheduledAlarmNotifications'),
  'native startup must not run obsolete numeric alarm migration cleanup');

const facade = read('src/utils/notifications.ts');
for (const token of [
  'iosCriticalAlarmId',
  'doseReminderAlarmIdForDose',
  'snoozeDoseReminderId',
  'clearLegacyScheduledAlarmNotifications',
  'notificationIds',
]) {
  assert(!facade.includes(token),
    'notification facade must not expose obsolete numeric identity machinery: ' + token);
}

for (const rel of javaFiles('native-android/auto-deduction')) {
  const content = read(rel);
  assert(!content.includes('NotificationRuntime'),
    'Auto production Java must not depend on NotificationRuntime: ' + rel);
  assert(!content.includes('NotificationManager'),
    'Auto production Java must not depend on NotificationManager: ' + rel);
  assert(!content.includes('NotificationChannel'),
    'Auto production Java must not depend on NotificationChannel: ' + rel);
}

for (const rel of javaFiles('native-android/alarm-runtime')) {
  const content = read(rel);
  assert(!content.includes('NotificationRuntime'),
    'Exact Alarm Runtime must remain notification-neutral: ' + rel);
}

for (const rel of javaFiles('native-android/notification-runtime')) {
  const content = read(rel);
  assert(!content.includes('AlarmManager') && !content.includes('ExactAlarmRuntime'),
    'Notification Runtime must not own exact-alarm scheduling: ' + rel);
}

const exactAlarmRuntime = read('native-android/alarm-runtime/ExactAlarmRuntime.java');
assert(exactAlarmRuntime.includes('AlarmManager'),
  'Exact Alarm Runtime must continue to own AlarmManager mechanics');
assert(!exactAlarmRuntime.includes('NotificationRuntime'),
  'Exact Alarm Runtime must not depend on Notification Runtime');

const notificationJava = read('native-android/notification-runtime/NotificationRuntime.java');
assert(notificationJava.includes('notificationTag(namespace, identity)'),
  'Android Notification Runtime must use namespace + identity as logical notification authority');

const autoNative = read('src/utils/autoDeductionNativePlugin.ts');
assert(!autoNative.includes('notificationRuntime') && !autoNative.includes('NotificationRuntime')
  && !autoNative.includes('notificationId('),
  'Auto native TypeScript bridge must remain outside notification identity/presentation infrastructure');

console.log('PASS: Phase 7 notification identity machinery boundary checks');