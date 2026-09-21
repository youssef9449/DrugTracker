/**
 * Phase 9 final architecture regression gate.
 *
 * This script is intentionally self-contained and cross-platform.
 * Run directly with Node; no npm/npx is required.
 *
 * It verifies the final architecture contract:
 *   9.1 mechanism ownership / transaction centralization
 *   9.2 cross-feature coexistence proof presence
 *   9.3 cancellation isolation proof presence
 *   9.4 identity isolation proof presence
 *   9.5 singular lifecycle / permission / recovery entry
 *   9.6 deletion of retired duplicate infrastructure
 *
 * This is a structural gate. The Robolectric cross-feature test is the runtime
 * proof and must still be executed by a real test runner/CI; this script does
 * not pretend that source inspection is runtime execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditScript = 'scripts/test-final-alarm-architecture-phase9.mjs';

function normalize(rel) {
  return rel.split(path.sep).join('/');
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function listFilesRecursive(relDir) {
  const out = [];
  function walk(absDir, currentRel) {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = normalize(path.join(currentRel, entry.name));
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

function count(content, literal) {
  return content.split(literal).length - 1;
}

function productionJavaFiles() {
  return listFilesRecursive('native-android')
    .filter((rel) =>
      rel.endsWith('.java')
      && !rel.startsWith('native-android/jvm-tests/')
    );
}

const javaFiles = productionJavaFiles();
const runtime = 'native-android/alarm-runtime/ExactAlarmRuntime.java';
const store = 'native-android/alarm-runtime/ExactAlarmStore.java';
const contract = 'native-android/alarm-runtime/ExactAlarmContract.java';
const lifecycle = 'native-android/alarm-runtime/ExactAlarmLifecycle.java';
const systemReceiver =
  'native-android/alarm-runtime/DrugTrackerAlarmSystemReceiver.java';
const operationLock =
  'native-android/alarm-runtime/ExactAlarmOperationLock.java';
const featureAdapter =
  'native-android/alarm-runtime/ExactAlarmFeatureAdapter.java';
const notificationRuntime =
  'native-android/notification-runtime/NotificationRuntime.java';
const autoScheduler =
  'native-android/auto-deduction/AutoDeductionScheduler.java';
const autoAdapter =
  'native-android/auto-deduction/AutoDeductionSchedulingAdapter.java';
const autoReceiver =
  'native-android/auto-deduction/AutoDeductionReceiver.java';
const criticalAdapter =
  'native-android/critical-stock/CriticalStockAlarmAdapter.java';
const doseAdapter =
  'native-android/dose-reminder/DoseReminderAlarmAdapter.java';
const doseFeature =
  'native-android/alarm-runtime/DoseReminderAlarmFeature.java';

for (const required of [
  runtime, store, contract, lifecycle, systemReceiver, operationLock,
  featureAdapter, notificationRuntime, autoScheduler, autoAdapter,
  autoReceiver, criticalAdapter, doseAdapter, doseFeature,
]) {
  assert(
    fs.existsSync(path.join(root, required)),
    'Required production source is missing: ' + required
  );
}

const runtimeContent = read(runtime);
const storeContent = read(store);
const contractContent = read(contract);
const lifecycleContent = read(lifecycle);
const systemReceiverContent = read(systemReceiver);
const notificationRuntimeContent = read(notificationRuntime);
const autoSchedulerContent = read(autoScheduler);
const autoAdapterContent = read(autoAdapter);
const autoReceiverContent = read(autoReceiver);
const criticalAdapterContent = read(criticalAdapter);
const doseAdapterContent = read(doseAdapter);
const doseFeatureContent = read(doseFeature);

// ---------------------------------------------------------------------------
// 9.1 Shared mechanism ownership
// ---------------------------------------------------------------------------

for (const rel of javaFiles) {
  const content = read(rel);
  if (rel === runtime) continue;

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
      && !content.includes('setExact(')
      && !content.includes('manager.set('),
    'AlarmManager scheduling installation must remain in ExactAlarmRuntime only: ' + rel
  );
  if (rel !== notificationRuntime) {
    assert(
      !content.includes('PendingIntent.getBroadcast('),
      'Alarm PendingIntent construction/matching must remain in ExactAlarmRuntime only; NotificationRuntime is the sole notification-action exception: ' + rel
    );
  }
  else {
    assert(
      count(content, 'PendingIntent.getBroadcast(') === 1
        && content.includes('NotificationRuntimeActionReceiver.class'),
      'NotificationRuntime PendingIntent must remain limited to its notification-action receiver'
    );
  }
  assert(
    !content.includes('PendingIntent.FLAG_NO_CREATE'),
    'Alarm PendingIntent matching must remain in ExactAlarmRuntime only: ' + rel
  );
}

assert(
  count(runtimeContent, 'PendingIntent.getBroadcast(') === 2,
  'ExactAlarmRuntime must contain the two shared PendingIntent operations (isPending + build)'
);
assert(
  count(runtimeContent, 'setExactAndAllowWhileIdle(') === 2,
  'ExactAlarmRuntime must contain the durable + one-shot exact install paths'
);
assert(
  count(runtimeContent, 'AlarmManager.cancel(') === 0,
  'Runtime cancellation must use the concrete manager instance, not a second static implementation'
);
assert(
  /\bmanager\.cancel\s*\(\s*pendingIntent\s*\)/.test(runtimeContent),
  'ExactAlarmRuntime must own concrete manager.cancel(pendingIntent)'
);
assert(
  /\bmanager\.setExactAndAllowWhileIdle\s*\(/.test(runtimeContent),
  'ExactAlarmRuntime must own concrete manager.setExactAndAllowWhileIdle(...)'
);
assert(
  runtimeContent.includes('manager.set('),
  'ExactAlarmRuntime must own the allowed one-shot inexact fallback'
);
assert(
  count(runtimeContent, 'manager.canScheduleExactAlarms()') === 1,
  'ExactAlarmRuntime must contain the single direct Android exact-alarm permission probe'
);

const permissionProbeFiles = javaFiles.filter((rel) =>
  read(rel).includes('manager.canScheduleExactAlarms()')
);
assert(
  permissionProbeFiles.length === 1 && permissionProbeFiles[0] === runtime,
  'Direct AlarmManager.canScheduleExactAlarms() usage must exist only in ExactAlarmRuntime'
);

// Shared store boundary: only the shared runtime may instantiate or access ExactAlarmStore.
assert(
  count(runtimeContent, 'new ExactAlarmStore(') === 1,
  'ExactAlarmRuntime must own the single ExactAlarmStore construction'
);
for (const rel of javaFiles) {
  if (rel === runtime || rel === store) continue;
  assert(
    !read(rel).includes('ExactAlarmStore'),
    'Feature/lifecycle code must not depend directly on ExactAlarmStore: ' + rel
  );
}

// Shared lock boundary: feature code cannot instantiate or synchronize on the shared lock directly.
for (const rel of javaFiles) {
  if (rel === runtime || rel === store) continue;
  const content = read(rel);
  assert(
    !content.includes('new ExactAlarmOperationLock'),
    'Feature code must not instantiate ExactAlarmOperationLock: ' + rel
  );
  assert(
    !content.includes('synchronized (ExactAlarmOperationLock.LOCK)'),
    'Feature code must not synchronize on ExactAlarmOperationLock.LOCK directly: ' + rel
  );
}

// Generic shared runtime must remain feature-neutral.
for (const forbidden of [
  'AutoDeduction',
  'CriticalStock',
  'DoseReminder',
  'FIRED',
  'RECONCILED',
  'recurrenceGeneration',
  'retryCount',
  'medicationId',
  'doseId',
]) {
  assert(
    !runtimeContent.includes(forbidden),
    'ExactAlarmRuntime must remain feature-neutral; forbidden business symbol found: '
      + forbidden
  );
}

// No feature-local generic identity builder.
assert(
  count(contractContent, 'public static Uri buildIdentityUri(') === 1,
  'ExactAlarmContract must contain exactly one generic alarm identity builder'
);
for (const rel of [autoAdapter.replace('AutoDeductionSchedulingAdapter.java','AutoDeductionContract.java'), criticalAdapter, doseAdapter]) {
  // Feature contracts/adapters may call the shared builder but must not build the URI independently.
  const content = read(rel);
  assert(
    !content.includes('new Uri.Builder()'),
    'Feature alarm identity must not use a second Uri.Builder implementation: ' + rel
  );
}
for (const rel of [
  'native-android/auto-deduction/AutoDeductionContract.java',
  criticalAdapter,
  doseAdapter,
]) {
  assert(
    read(rel).includes('ExactAlarmContract.buildIdentityUri('),
    'Feature alarm identity must delegate to ExactAlarmContract: ' + rel
  );
}

// Transaction ordering: verify the concrete order, not just symbol presence.
const scheduleWrite = runtimeContent.indexOf('store.writeScheduleLocked(');
const scheduleInstall = runtimeContent.indexOf('manager.setExactAndAllowWhileIdle(');
const scheduleRollback = runtimeContent.indexOf('rollbackScheduleLocked(');
const supersedeCleanup = runtimeContent.indexOf('store.clearCancellationIfSupersededLocked(');
assert(
  scheduleWrite >= 0
    && scheduleInstall > scheduleWrite
    && supersedeCleanup > scheduleInstall,
  'Schedule transaction order must be metadata write -> AlarmManager install -> superseded tombstone cleanup'
);
assert(
  runtimeContent.includes('private void rollbackScheduleLocked(')
    && runtimeContent.includes('store.removeScheduleIfOwnedLocked('),
  'Schedule rollback must remain ownership-safe inside ExactAlarmRuntime'
);

const tombstoneWrite = runtimeContent.indexOf('store.writeCancellationTombstoneLocked(');
const cancelCall = runtimeContent.search(/\bmanager\.cancel\s*\(\s*pendingIntent\s*\)/);
const metadataRemove = runtimeContent.indexOf('store.removeScheduleLocked(');
assert(
  tombstoneWrite >= 0
    && cancelCall > tombstoneWrite
    && metadataRemove > cancelCall,
  'Cancel transaction order must be tombstone -> AlarmManager.cancel -> metadata removal'
);

// Operation ordering has one allocator implementation.
const orderingImplementations = javaFiles.filter((rel) =>
  read(rel).includes('allocateOperationVersionLocked(')
);
assert(
  orderingImplementations.length === 2
    && orderingImplementations.includes(runtime)
    && orderingImplementations.includes(store),
  'operationVersion allocation must be implemented by ExactAlarmStore and consumed by ExactAlarmRuntime only'
);
assert(
  contractContent.includes('ORDERING_SEQUENCE_KEY')
    && contractContent.includes('operationVersion'),
  'ExactAlarmContract must own the generic ordering key/token contract'
);

// ---------------------------------------------------------------------------
// 9.2 / 9.3 / 9.4 Cross-feature runtime proof
// ---------------------------------------------------------------------------

const crossFeatureTest =
  'native-android/jvm-tests/src/test/java/app/drugtracker/alarmruntime/CrossFeatureAlarmIsolationTest.java';
assert(
  fs.existsSync(path.join(root, crossFeatureTest)),
  'Cross-feature coexistence/cancellation/identity runtime proof is missing'
);
const crossFeatureContent = read(crossFeatureTest);

assert(
  crossFeatureContent.includes(
    'AutoDeductionContract.occurrenceKey('
  ),
  'Cross-feature test must use the current 9-parameter Auto adapter contract'
);
assert(
  crossFeatureContent.includes('"08:00"')
    && crossFeatureContent.includes('TRIGGER_AT'),
  'Cross-feature test must exercise the same 08:00 trigger instant'
);
assert(
  count(crossFeatureContent, 'scheduleAllThree()') >= 3,
  'Cross-feature cancellation isolation must exercise all three cancellation directions'
);
assert(
  crossFeatureContent.includes('scheduledPendingIntentIdentities()')
    && crossFeatureContent.includes('getRequestCode()')
    && crossFeatureContent.includes('getComponent()')
    && crossFeatureContent.includes('getData()'),
  'Cross-feature identity proof must inspect full PendingIntent identity components'
);
assert(
  crossFeatureContent.includes('ACTION_AUTO_DEDUCTION')
    && crossFeatureContent.includes('ACTION_DOSE_REMINDER')
    && crossFeatureContent.includes('ACTION_CRITICAL_STOCK'),
  'Cross-feature identity proof must validate all three feature actions'
);

// ---------------------------------------------------------------------------
// 9.5 Lifecycle + permission + recovery
// ---------------------------------------------------------------------------

const systemActions = [
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.QUICKBOOT_POWERON',
  'android.intent.action.TIMEZONE_CHANGED',
  'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
];

for (const action of systemActions) {
  assert(
    systemReceiverContent.includes(action)
      || (action === 'android.intent.action.BOOT_COMPLETED'
        && systemReceiverContent.includes('Intent.ACTION_BOOT_COMPLETED'))
      || (action === 'android.intent.action.TIMEZONE_CHANGED'
        && systemReceiverContent.includes('Intent.ACTION_TIMEZONE_CHANGED')),
    'Shared system receiver must cover lifecycle action: ' + action
  );
}

for (const rel of javaFiles) {
  const content = read(rel);
  if (rel === systemReceiver || rel === lifecycle) continue;
  for (const action of systemActions) {
    assert(
      !content.includes(action),
      'System lifecycle action must not appear in feature/native code: '
        + rel + ' contains ' + action
    );
  }
  assert(
    !content.includes('Intent.ACTION_BOOT_COMPLETED')
      && !content.includes('Intent.ACTION_TIMEZONE_CHANGED'),
    'System lifecycle Intent constants must remain centralized: ' + rel
  );
}

assert(
  count(systemReceiverContent, 'ExactAlarmLifecycle.restoreAll(') === 1,
  'Shared system receiver must have exactly one restoreAll dispatch'
);
assert(
  count(lifecycleContent, 'public static void restoreAll(') === 1,
  'ExactAlarmLifecycle must have exactly one restoreAll implementation'
);
assert(
  lifecycleContent.includes('ExactAlarmRuntime.canScheduleExactAlarms(appContext)'),
  'ExactAlarmLifecycle must use the shared exact-alarm permission capability source'
);
assert(
  lifecycleContent.includes('adapter.restore('),
  'ExactAlarmLifecycle must dispatch to feature adapters'
);

// Feature delivery receivers must not handle system lifecycle broadcasts.
for (const rel of [
  autoReceiver,
  'native-android/critical-stock/CriticalStockAlarmReceiver.java',
  'native-android/dose-reminder/DoseReminderAlarmReceiver.java',
]) {
  const content = read(rel);
  for (const action of systemActions) {
    assert(
      !content.includes(action)
        && !content.includes('Intent.ACTION_BOOT_COMPLETED')
        && !content.includes('Intent.ACTION_TIMEZONE_CHANGED'),
      'Feature delivery receiver must not handle system lifecycle events: ' + rel
    );
  }
}

// There must be one system receiver by source name.
const systemReceiverSources = javaFiles.filter((rel) =>
  /SystemReceiver\.java$/i.test(path.basename(rel))
);
assert(
  systemReceiverSources.length === 1
    && systemReceiverSources[0] === systemReceiver,
  'Exactly one native SystemReceiver source must exist, and it must be DrugTrackerAlarmSystemReceiver'
);

// prepare-android is the manifest/source installation authority in this repository.
const preparePath = 'scripts/prepare-android.mjs';
const prepare = read(preparePath);
assert(
  prepare.includes('app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver'),
  'prepare-android must register the shared system lifecycle receiver'
);
assert(
  prepare.includes('app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS'),
  'prepare-android must register the shared feature adapter metadata'
);
for (const adapterName of [
  'app.drugtracker.autodeduction.AutoDeductionAlarmFeature',
  'app.drugtracker.criticalstock.CriticalStockAlarmAdapter',
  'app.drugtracker.alarmruntime.DoseReminderAlarmFeature',
]) {
  assert(
    prepare.includes(adapterName),
    'prepare-android must register lifecycle adapter: ' + adapterName
  );
}
for (const legacy of [
  'app.drugtracker.autodeduction.AutoDeductionSystemReceiver',
  'app.drugtracker.criticalstock.CriticalStockSystemReceiver',
  'app.drugtracker.dosereminder.DoseReminderSystemReceiver',
  'app.drugtracker.alarmruntime.ExactAlarmSystemReceiver',
]) {
  assert(
    prepare.includes(legacy)
      && prepare.includes('removeReceiverByName'),
    'prepare-android must retain explicit legacy receiver removal for: ' + legacy
  );
}

// ---------------------------------------------------------------------------
// 9.6 Dead-code deletion / stale contract sweep
// ---------------------------------------------------------------------------

const retiredSourceNames = [
  'AutoDeductionSystemReceiver.java',
  'CriticalStockSystemReceiver.java',
  'DoseReminderSystemReceiver.java',
  'CriticalStockLifecycle.java',
  'CriticalStockScheduler.java',
  'CriticalStockAlarmScheduler.java',
  'ExactAlarmSystemReceiver.java',
];

const allRepoFiles = [
  ...listFilesRecursive('native-android'),
  ...listFilesRecursive('src'),
  ...listFilesRecursive('docs'),
].concat(
  fs.existsSync(path.join(root, 'BUILD_APK.md')) ? ['BUILD_APK.md'] : []
);

for (const retired of retiredSourceNames) {
  assert(
    !allRepoFiles.includes('native-android/' + retired)
      && !allRepoFiles.some((rel) => path.basename(rel) === retired),
    'Retired source file remains: ' + retired
  );
}

const staleContentFiles = allRepoFiles.filter((rel) =>
  /\.(java|ts|tsx|md)$/.test(rel)
);
const staleTerms = [
  'AutoDeductionSystemReceiver',
  'CriticalStockSystemReceiver',
  'DoseReminderSystemReceiver',
  'CriticalStockLifecycle',
  'CriticalStockScheduler',
  'CriticalStockAlarmScheduler',
  'changeExactNotificationSetting',
  'checkExactNotificationSetting',
];

for (const rel of staleContentFiles) {
  const content = read(rel);
  for (const term of staleTerms) {
    assert(
      !content.includes(term),
      'Retired/stale contract reference remains in production/source/docs: '
        + rel + ' contains ' + term
    );
  }
}

// Notification registry machinery is gone; only the explicit stable runtime id remains.
for (const retired of [
  'NOTIFICATION_ID_BASE',
  'ID_RANGE_SIZE',
  'hashToRange',
  'notificationIdRegistry',
  'numericNotificationRange',
]) {
  assert(
    !notificationRuntimeContent.includes(retired),
    'Retired notification-id registry machinery remains: ' + retired
  );
}

// Auto must not know NotificationRuntime at all.
for (const rel of [
  'native-android/auto-deduction/AutoDeductionContract.java',
  autoScheduler,
  autoAdapter,
  autoReceiver,
  'native-android/auto-deduction/AutoDeductionLifecycle.java',
  'native-android/auto-deduction/AutoDeductionAlarmFeature.java',
]) {
  assert(
    !read(rel).includes('NotificationRuntime'),
    'Auto Deduction must not depend on NotificationRuntime: ' + rel
  );
}

// Auto business code cannot touch the shared native mechanism directly.
for (const rel of [
  autoScheduler,
  'native-android/auto-deduction/AutoDeductionContract.java',
  'native-android/auto-deduction/AutoDeductionAlarmFeature.java',
  'native-android/auto-deduction/AutoDeductionLifecycle.java',
]) {
  const content = read(rel);
  assert(
    !content.includes('ExactAlarmStore'),
    'Auto business/lifecycle code must not depend on ExactAlarmStore directly: ' + rel
  );
  assert(
    !content.includes('PendingIntent.getBroadcast('),
    'Auto business/lifecycle code must not construct PendingIntent directly: ' + rel
  );
  assert(
    !content.includes('Context.ALARM_SERVICE'),
    'Auto business/lifecycle code must not access AlarmManager directly: ' + rel
  );
  assert(
    !content.includes('AlarmManager.cancel('),
    'Auto business/lifecycle code must not cancel AlarmManager directly: ' + rel
  );
}

// Feature adapters remain adapters: they delegate to ExactAlarmRuntime rather than duplicating the mechanism.
for (const [rel, expected] of [
  [autoAdapter, 'alarmRuntime.schedule('],
  [criticalAdapter, 'runtime.schedule('],
  [doseAdapter, 'runtime.schedule('],
]) {
  assert(
    read(rel).includes(expected),
    'Feature scheduling boundary must delegate into ExactAlarmRuntime: ' + rel
  );
}
for (const [rel, expected] of [
  [autoAdapter, 'alarmRuntime.cancel('],
  [criticalAdapter, 'runtime.cancel('],
  [doseAdapter, 'runtime.cancel('],
]) {
  assert(
    read(rel).includes(expected),
    'Feature cancellation boundary must delegate into ExactAlarmRuntime: ' + rel
  );
}

// Dose business boundary must not know Auto business state.
assert(
  !doseAdapterContent.includes('autoDeductEnabled')
    && !doseFeatureContent.includes('autoDeductEnabled')
    && !doseFeatureContent.includes('PREFS_RECURRENCE_AUTH'),
  'Dose Reminder native path must not depend on Auto recurrence/business state'
);

// Critical adapter must not contain Auto lifecycle/business state.
assert(
  !criticalAdapterContent.includes('AutoDeduction')
    && !criticalAdapterContent.includes('FIRED')
    && !criticalAdapterContent.includes('RECONCILED')
    && !criticalAdapterContent.includes('PREFS_RECURRENCE_AUTH'),
  'Critical Stock adapter must not contain Auto lifecycle/business state'
);

// Final audit itself must be runnable on Windows and POSIX.
assert(
  auditScript === normalize(auditScript),
  'Final audit path normalization contract is malformed'
);
assert(
  listFilesRecursive('native-android')
    .every((rel) => normalize(rel) === rel),
  'Final audit must normalize native file paths for Windows/POSIX consistency'
);

console.log('PASS: Phase 9 final deletion + cross-system architecture audit');
