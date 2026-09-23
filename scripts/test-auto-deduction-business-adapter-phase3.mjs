/**
 * Structural regression checks for the Phase 3 Auto Deduction business/adapter boundary.
 * Run: node scripts/test-auto-deduction-business-adapter-phase3.mjs
 * No npm/npx required.
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

const autoDir = path.join(root, 'native-android', 'auto-deduction');
const productionJavaFiles = fs
  .readdirSync(autoDir)
  .filter((name) => name.endsWith('.java'))
  .map((name) => path.join(autoDir, name));

const scheduler = read('native-android/auto-deduction/AutoDeductionScheduler.java');
const adapter = read('native-android/auto-deduction/AutoDeductionSchedulingAdapter.java');
const receiver = read('native-android/auto-deduction/AutoDeductionReceiver.java');
const runtime = read('native-android/alarm-runtime/ExactAlarmRuntime.java');
const store = read('native-android/alarm-runtime/ExactAlarmStore.java');
const lock = read('native-android/alarm-runtime/ExactAlarmOperationLock.java');

assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmRuntime'),
  'Auto business scheduler must not import ExactAlarmRuntime'
);
assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmStore;'),
  'Auto business scheduler must not import ExactAlarmStore'
);
assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmOperationLock;'),
  'Auto business scheduler must not import ExactAlarmOperationLock'
);
assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmContract;'),
  'Auto business scheduler must not import the shared exact-alarm contract'
);
assert(
  !scheduler.includes('import android.app.AlarmManager;'),
  'Auto business scheduler must not import AlarmManager'
);
assert(
  !scheduler.includes('import android.app.PendingIntent;'),
  'Auto business scheduler must not import PendingIntent'
);
assert(
  !scheduler.includes('Context.ALARM_SERVICE'),
  'Auto business scheduler must not resolve AlarmManager itself'
);
assert(
  !scheduler.includes('PendingIntent.getBroadcast'),
  'Auto business scheduler must not construct PendingIntent'
);
assert(
  !scheduler.includes('new ExactAlarmRuntime('),
  'Auto business scheduler must not construct the shared runtime'
);
assert(
  !scheduler.includes('alarmRuntime.'),
  'Auto business scheduler must not call the shared runtime directly'
);

assert(
  !scheduler.includes('AutoDeductionContract.PREFS_SCHEDULES'),
  'Auto business scheduler must not access the shared schedules preference'
);
assert(
  !scheduler.includes('AutoDeductionContract.PREFS_CANCELLED'),
  'Auto business scheduler must not access the shared cancellation preference'
);
assert(
  !scheduler.includes('AutoDeductionContract.PREFS_ORDERING'),
  'Auto business scheduler must not access the shared ordering preference'
);
assert(
  !scheduler.includes('SCHEDULE_KEY_PREFIX'),
  'Auto business scheduler must not know the shared schedule-key prefix'
);

const getSharedPrefsCount =
  (scheduler.match(/getSharedPreferences\(/g) || []).length;
assert(
  getSharedPrefsCount === 0,
  'Auto business scheduler facade must not own SharedPreferences stores after collaborator decomposition'
);

const recurrence = read('native-android/auto-deduction/AutoDeductionRecurrence.java');
const retryEvidenceStore =
  read('native-android/auto-deduction/AutoDeductionRetryEvidenceStore.java');

assert(
  (recurrence.match(/getSharedPreferences\(/g) || []).length === 1
    && recurrence.includes('AutoDeductionContract.PREFS_RECURRENCE_AUTH'),
  'recurrence authorization persistence must be owned by AutoDeductionRecurrence'
);
assert(
  (retryEvidenceStore.match(/getSharedPreferences\(/g) || []).length === 1
    && retryEvidenceStore.includes('AutoDeductionContract.PREFS_FIRE_RETRY'),
  'fire-retry persistence must be owned by AutoDeductionRetryEvidenceStore'
);

assert(
  scheduler.includes('schedulingAdapter.scheduleOccurrence('),
  'occurrence scheduling must cross the Auto scheduling adapter'
);
assert(
  scheduler.includes('schedulingAdapter.cancelOccurrence('),
  'occurrence cancellation must cross the Auto scheduling adapter'
);
assert(
  scheduler.includes('schedulingAdapter.scheduleFireRetry('),
  'retry alarm installation must cross the Auto scheduling adapter'
);
assert(
  scheduler.includes('AutoDeductionSchedulingAdapter.extractOperationVersion('),
  'shared operation-version parsing must cross the adapter boundary'
);
assert(
  scheduler.includes('AutoDeductionSchedulingAdapter.parseOrdering('),
  'shared ordering parsing must cross the adapter boundary'
);

assert(
  adapter.includes('import app.drugtracker.alarmruntime.ExactAlarmRuntime;'),
  'adapter must own the ExactAlarmRuntime dependency'
);
assert(
  adapter.includes('import app.drugtracker.alarmruntime.ExactAlarmContract;'),
  'adapter must own the shared contract dependency'
);
assert(
  adapter.includes('new ExactAlarmRuntime('),
  'adapter must construct the shared runtime'
);
assert(
  adapter.includes('new ExactAlarmRuntime.ScheduleRequest('),
  'adapter must translate Auto scheduling into a neutral ScheduleRequest'
);
assert(
  adapter.includes('alarmRuntime.schedule('),
  'adapter must delegate durable scheduling'
);
assert(
  adapter.includes('alarmRuntime.cancel('),
  'adapter must delegate cancellation'
);
assert(
  adapter.includes('alarmRuntime.scheduleOneShot('),
  'adapter must delegate the feature retry one-shot mechanism'
);
assert(
  !adapter.includes('ExactAlarmStore'),
  'adapter must not access ExactAlarmStore directly'
);
assert(
  !adapter.includes('SharedPreferences'),
  'adapter must not own SharedPreferences objects'
);

const featureMetadataStart = adapter.indexOf('JSONObject featureMetadata');
const featureMetadataEnd = adapter.indexOf('Bundle deliveryExtras', featureMetadataStart);
assert(
  featureMetadataStart >= 0 && featureMetadataEnd > featureMetadataStart,
  'adapter schedule translation must build featureMetadata and deliveryExtras separately'
);
const featureMetadataSection = adapter.slice(featureMetadataStart, featureMetadataEnd);
assert(
  !featureMetadataSection.includes('recurrenceGeneration'),
  'recurrenceGeneration must not enter Shared schedule metadata'
);
assert(
  !featureMetadataSection.includes('fireRetryCount'),
  'fireRetryCount must not enter Shared schedule metadata'
);

for (const filePath of productionJavaFiles) {
  const content = fs.readFileSync(filePath, 'utf8');
  assert(
    !/^import .*notificationruntime\./m.test(content),
    'Auto production file must not import Notification Runtime: ' + path.basename(filePath)
  );
  assert(
    !/^import android\.app\.Notification\b/m.test(content),
    'Auto production file must not import android.app.Notification: ' + path.basename(filePath)
  );
  assert(
    !/^import android\.app\.NotificationManager\b/m.test(content),
    'Auto production file must not import NotificationManager: ' + path.basename(filePath)
  );
}

assert(
  !receiver.includes('NotificationRuntime'),
  'Auto fire receiver must not depend on Notification Runtime'
);

assert(
  !runtime.includes('AutoDeduction'),
  'Shared exact-alarm runtime must remain feature-neutral'
);
assert(
  !store.includes('AutoDeduction'),
  'Shared exact-alarm store must remain feature-neutral'
);
assert(
  !lock.includes('AutoDeduction'),
  'Shared exact-alarm operation lock must remain feature-neutral'
);

console.log('PASS: Phase 3 Auto business/adapter boundary checks');
