/**
 * Phase 9 final architecture regression audit.
 * Run: node scripts/test-final-alarm-architecture-phase9.mjs
 * No npm/npx required.
 *
 * This is a structural audit complementing the Robolectric cross-feature
 * runtime test. It verifies that mechanism ownership stayed centralized,
 * feature identities remain isolated, lifecycle entry remains singular, and
 * retired duplicate machinery is gone.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function listFilesRecursive(relDir) {
  const out = [];
  function walk(absDir, currentRel) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = path.join(currentRel, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  }
  walk(path.join(root, relDir), relDir);
  return out;
}

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

function productionJavaFiles() {
  return listFilesRecursive('native-android')
    .filter((rel) => rel.endsWith('.java') && !rel.startsWith('native-android/jvm-tests/'));
}

const javaFiles = productionJavaFiles();
const runtime = 'native-android/alarm-runtime/ExactAlarmRuntime.java';
const store = 'native-android/alarm-runtime/ExactAlarmStore.java';
const contract = 'native-android/alarm-runtime/ExactAlarmContract.java';
const lifecycle = 'native-android/alarm-runtime/ExactAlarmLifecycle.java';
const systemReceiver = 'native-android/alarm-runtime/DrugTrackerAlarmSystemReceiver.java';
const notificationRuntime = 'native-android/notification-runtime/NotificationRuntime.java';

// 9.1 Exact-alarm mechanism ownership.
for (const rel of javaFiles) {
  const content = read(rel);
  if (rel !== runtime) {
    assert(
      !content.includes('import android.app.AlarmManager;'),
      'AlarmManager import must remain in ExactAlarmRuntime only: ' + rel
    );
    assert(
      !content.includes('Context.ALARM_SERVICE'),
      'AlarmManager service lookup must remain in ExactAlarmRuntime only: ' + rel
    );
    assert(
      !content.includes('setExactAndAllowWhileIdle(')
        && !content.includes('setExact('),
      'Exact alarm installation must remain in ExactAlarmRuntime only: ' + rel
    );
    assert(
      !content.includes('PendingIntent.FLAG_NO_CREATE'),
      'Alarm PendingIntent matching must remain in ExactAlarmRuntime only: ' + rel
    );
  }
}
assert(
  read(runtime).includes('PendingIntent.getBroadcast('),
  'ExactAlarmRuntime must own alarm PendingIntent construction'
);
assert(
  read(runtime).includes('AlarmManager.RTC_WAKEUP'),
  'ExactAlarmRuntime must own AlarmManager exact-alarm installation'
);
assert(
  read(runtime).includes('rollbackScheduleLocked('),
  'ExactAlarmRuntime must own schedule rollback'
);
assert(
  read(runtime).includes('manager.canScheduleExactAlarms()'),
  'ExactAlarmRuntime must own the direct Android exact-alarm permission probe'
);
const permissionProbeFiles = javaFiles.filter((rel) =>
  read(rel).includes('manager.canScheduleExactAlarms()')
);
assert(
  permissionProbeFiles.length === 1 && permissionProbeFiles[0] === runtime,
  'Direct AlarmManager.canScheduleExactAlarms() usage must exist only in ExactAlarmRuntime'
);

const alarmApiImplementationFiles = javaFiles.filter((rel) => {
  const content = read(rel);
  return content.includes('AlarmManager.cancel(')
    || content.includes('PendingIntent.getBroadcast(');
});
assert(
  alarmApiImplementationFiles.every(
    (rel) => rel === runtime || rel === notificationRuntime
  ),
  'AlarmManager.cancel / PendingIntent.getBroadcast may exist only in ExactAlarmRuntime, with NotificationRuntime allowed for notification-action PendingIntent delivery'
);
assert(
  alarmApiImplementationFiles.includes(runtime),
  'ExactAlarmRuntime must remain the concrete alarm API implementation'
);
assert(
  alarmApiImplementationFiles.includes(notificationRuntime),
  'NotificationRuntime must remain the only separate notification-action PendingIntent implementation'
);
assert(
  !javaFiles.some((rel) =>
    rel !== runtime && read(rel).includes('rollbackScheduleLocked(')
  ),
  'Exact-alarm rollback implementation must remain unique to ExactAlarmRuntime'
);
assert(
  !javaFiles.some((rel) =>
    rel !== runtime && read(rel).includes('AlarmManager.cancel(')
  ),
  'AlarmManager.cancel implementation must remain unique to ExactAlarmRuntime'
);

// Operation ordering / serialization has one production implementation.
const orderingImplementations = javaFiles.filter((rel) =>
  read(rel).includes('allocateOperationVersionLocked(')
);
assert(
  orderingImplementations.length === 2
    && orderingImplementations.includes(runtime)
    && orderingImplementations.includes(store),
  'Operation-version allocation must be implemented by ExactAlarmStore and consumed by ExactAlarmRuntime only'
);
for (const rel of javaFiles) {
  if (rel === runtime || rel === store) continue;
  assert(
    !read(rel).includes('new ExactAlarmOperationLock'),
    'Feature code must not instantiate its own shared alarm operation lock: ' + rel
  );
  assert(
    !read(rel).includes('synchronized (ExactAlarmOperationLock.LOCK)'),
    'Feature code must not implement the shared lock boundary directly: ' + rel
  );
}

// Identity construction is centralized in ExactAlarmContract; features only call it.
assert(
  (read(contract).match(/public static Uri buildIdentityUri\(/g) || []).length === 1,
  'ExactAlarmContract must have exactly one generic native alarm identity constructor'
);
for (const rel of [
  'native-android/auto-deduction/AutoDeductionContract.java',
  'native-android/critical-stock/CriticalStockAlarmAdapter.java',
  'native-android/dose-reminder/DoseReminderAlarmAdapter.java',
]) {
  assert(
    read(rel).includes('ExactAlarmContract.buildIdentityUri('),
    'Feature identity must use ExactAlarmContract: ' + rel
  );
}

const autoScheduler = read('native-android/auto-deduction/AutoDeductionScheduler.java');
const autoSchedulingAdapter = read('native-android/auto-deduction/AutoDeductionSchedulingAdapter.java');
const criticalAdapter = read('native-android/critical-stock/CriticalStockAlarmAdapter.java');
const doseFeature = read('native-android/alarm-runtime/DoseReminderAlarmFeature.java');
assert(
  (read(contract).match(/public static long resolveLocalDateTimeEpochMs\(/g) || []).length === 1,
  'ExactAlarmContract must own the single generic local date/time → epoch implementation'
);
assert(
  !autoScheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmContract;')
    && /AutoDeductionSchedulingAdapter\.resolveLocalDateTimeEpochMs\(\s*calendarDate,\s*timeHhmm,\s*true\)/.test(
      autoScheduler
    ),
  'Auto Deduction business scheduler must cross the shared datetime mechanism only through its scheduling adapter'
);
assert(
  autoSchedulingAdapter.includes('ExactAlarmContract.resolveLocalDateTimeEpochMs(')
    && autoSchedulingAdapter.includes('boolean lenient'),
  'Auto scheduling adapter must own the feature-to-shared datetime conversion boundary'
);
assert(
  criticalAdapter.includes(
    'ExactAlarmContract.resolveLocalDateTimeEpochMs(date, time, false)'
  ) && !criticalAdapter.includes('private static long resolveLocalDateTime('),
  'Critical Stock restore must use the shared strict local date/time conversion'
);
assert(
  (doseFeature.match(
    /ExactAlarmContract\.resolveLocalDateTimeEpochMs\(calendarDate, reminderTime, false\)/g
  ) || []).length === 2
    && !doseFeature.includes('SimpleDateFormat')
    && !doseFeature.includes('private static long resolve('),
  'Dose Reminder restore must use the shared strict local date/time conversion'
);

// 9.2 / 9.4 Cross-feature identities have distinct namespaces.
const autoUri = read('native-android/auto-deduction/AutoDeductionContract.java');
const doseUri = read('native-android/dose-reminder/DoseReminderAlarmAdapter.java');
const criticalUri = read('native-android/critical-stock/CriticalStockAlarmAdapter.java');
assert(autoUri.includes('"auto-deduction"'), 'Auto identity namespace missing');
assert(doseUri.includes('"dose-reminder"'), 'Dose identity namespace missing');
assert(doseUri.includes('"dose-reminder-snooze"'), 'Dose snooze identity namespace missing');
assert(criticalUri.includes('"critical-stock"'), 'Critical identity namespace missing');
assert(
  autoUri.includes('PENDING_INTENT_REQUEST_CODE')
    && doseUri.includes('PENDING_INTENT_REQUEST_CODE')
    && criticalUri.includes('PENDING_INTENT_REQUEST_CODE'),
  'Each feature must retain an explicit PendingIntent request-code namespace'
);

// 9.5 Single lifecycle entry/recovery dispatcher.
const sharedLifecycleActions = [
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.QUICKBOOT_POWERON',
  'android.intent.action.TIMEZONE_CHANGED',
  'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
];
const sharedLifecycleContent = read(systemReceiver);
for (const action of sharedLifecycleActions) {
  assert(
    sharedLifecycleContent.includes(action)
      || (action === 'android.intent.action.BOOT_COMPLETED'
        && sharedLifecycleContent.includes('Intent.ACTION_BOOT_COMPLETED'))
      || (action === 'android.intent.action.TIMEZONE_CHANGED'
        && sharedLifecycleContent.includes('Intent.ACTION_TIMEZONE_CHANGED')),
    'Shared system lifecycle receiver must cover: ' + action
  );
}
for (const rel of javaFiles) {
  const content = read(rel);
  if (rel !== systemReceiver && !rel.includes('/ExactAlarmLifecycle.java')) {
    assert(
      !content.includes('Intent.ACTION_BOOT_COMPLETED')
        && !content.includes('Intent.ACTION_TIMEZONE_CHANGED'),
      'System lifecycle actions must remain in the shared receiver: ' + rel
    );
  }
}
assert(
  read(systemReceiver).includes('ExactAlarmLifecycle.restoreAll('),
  'Shared system receiver must delegate to ExactAlarmLifecycle'
);
assert(
  read(lifecycle).includes('ExactAlarmRuntime.canScheduleExactAlarms(appContext)'),
  'ExactAlarmLifecycle must use the shared exact-alarm capability source'
);
assert(
  read(lifecycle).includes('adapter.restore('),
  'ExactAlarmLifecycle must dispatch to feature adapters'
);

// No parallel feature SystemReceiver files.
for (const dir of [
  'native-android/auto-deduction',
  'native-android/critical-stock',
  'native-android/dose-reminder',
]) {
  const receivers = fs.readdirSync(path.join(root, dir))
    .filter((name) => /SystemReceiver\.java$/i.test(name));
  assert(receivers.length === 0, 'Parallel feature system receiver remains: ' + dir);
}

// 9.6 Retired duplicate machinery must stay deleted.
const nativeNames = javaFiles.map((rel) => path.basename(rel));
assert(
  !nativeNames.includes('AutoDeductionSystemReceiver.java')
    && !nativeNames.includes('CriticalStockSystemReceiver.java')
    && !nativeNames.includes('DoseReminderSystemReceiver.java'),
  'Retired feature system receiver source files must not exist'
);

const productionTextFiles = [
  ...listFilesRecursive('src'),
  ...listFilesRecursive('docs'),
  'BUILD_APK.md',
].filter((rel) => /\.(ts|tsx|md)$/.test(rel));

for (const rel of productionTextFiles) {
  const content = read(rel);
  assert(
    !content.includes('AutoDeductionSystemReceiver')
      && !content.includes('AutoDeductionSystemRx')
      && !content.includes('CriticalStockSystemReceiver')
      && !content.includes('DoseReminderSystemReceiver'),
    'Retired lifecycle receiver reference remains in production/documentation: ' + rel
  );
  assert(
    !content.includes('changeExactNotificationSetting')
      && !content.includes('checkExactNotificationSetting'),
    'Retired Capacitor exact-notification permission API reference remains in production/documentation: ' + rel
  );
}

assert(
  !autoUri.includes('KEY_ORDERING_SEQ'),
  'Auto contract must not retain a duplicate shared ordering-key constant'
);
assert(
  read(notificationRuntime).includes('private static final int NOTIFICATION_ID = 1;'),
  'NotificationRuntime stable platform notification id must remain explicit and centralized'
);
assert(
  !read(notificationRuntime).includes('NOTIFICATION_ID_BASE')
    && !read(notificationRuntime).includes('ID_RANGE_SIZE')
    && !read(notificationRuntime).includes('hashToRange'),
  'Retired numeric notification range/registry machinery must remain deleted'
);

// Previously-closed phase audits remain part of the final architecture gate.
for (const rel of [
  'scripts/test-auto-deduction-business-adapter-phase3.mjs',
  'scripts/test-critical-stock-boundary-phase4.mjs',
  'scripts/test-dose-reminder-boundary-phase5.mjs',
  'scripts/test-alarm-notification-boundary-phase6.mjs',
  'scripts/test-notification-id-machinery-phase7.mjs',
  'scripts/test-exact-alarm-lifecycle-unification-phase8.mjs',
]) {
  assert(
    fs.existsSync(path.join(root, rel)),
    'Required prior-phase architecture audit is missing: ' + rel
  );
}

// Async race protections are still exercised by the feature-specific suites.
for (const rel of [
  'Tests/hooks/useAutoDeductionScheduler.test.ts',
  'Tests/hooks/useCriticalAlarmScheduler.test.ts',
  'Tests/hooks/useDoseReminderScheduler.test.ts',
]) {
  assert(fs.existsSync(path.join(root, rel)), 'Required async-race feature test is missing: ' + rel);
}

// Cross-system runtime proof must exist in the native JVM suite.
assert(
  fs.existsSync(path.join(
    root,
    'native-android/jvm-tests/src/test/java/app/drugtracker/alarmruntime/CrossFeatureAlarmIsolationTest.java'
  )),
  'Cross-feature runtime coexistence/cancellation proof is missing'
);

console.log('PASS: Phase 9 final deletion + cross-system architecture audit');
