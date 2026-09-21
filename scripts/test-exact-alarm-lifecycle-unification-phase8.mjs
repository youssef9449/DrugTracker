/**
 * Structural regression checks for Phase 8 lifecycle + permission + recovery unification.
 * Run: node scripts/test-exact-alarm-lifecycle-unification-phase8.mjs
 * No npm/npx required.
 *
 * Contract:
 *   BOOT / QUICKBOOT / TIMEZONE / exact-alarm permission change
 *      -> DrugTrackerAlarmSystemReceiver
 *      -> ExactAlarmLifecycle
 *      -> Auto / Critical / Dose feature adapters
 *
 * Feature delivery receivers are separate: they deliver already-scheduled
 * feature alarms only. They must not consume Android system lifecycle events.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function listJavaFiles(relDir) {
  return fs
    .readdirSync(path.join(root, relDir))
    .filter((name) => name.endsWith('.java'))
    .map((name) => path.join(relDir, name));
}

function listFilesRecursive(relDir) {
  const out = [];
  function walk(absDir, relDirCurrent) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      const rel = path.join(relDirCurrent, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel);
      }
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

const sharedReceiver =
  'native-android/alarm-runtime/DrugTrackerAlarmSystemReceiver.java';

const systemActions = [
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.QUICKBOOT_POWERON',
  'android.intent.action.TIMEZONE_CHANGED',
  'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
];

const nativeFiles = listFilesRecursive('native-android')
  .filter((rel) => rel.endsWith('.java'));

for (const rel of nativeFiles) {
  const content = read(rel);
  for (const action of systemActions) {
    if (content.includes(action)) {
      assert(
        rel === sharedReceiver,
        'Android system lifecycle action must exist only in the shared system receiver: '
          + rel
          + ' contains '
          + action
      );
    }
  }
}

// No feature-specific system lifecycle receivers may exist.
for (const relDir of [
  'native-android/auto-deduction',
  'native-android/critical-stock',
  'native-android/dose-reminder',
]) {
  const names = fs
    .readdirSync(path.join(root, relDir))
    .filter((name) => /SystemReceiver\\.java$/i.test(name));
  assert(
    names.length === 0,
    'Feature package must not contain a parallel system receiver: '
      + relDir
      + ' -> '
      + names.join(', ')
  );
}

// The shared receiver owns system-event entry and delegates only to the shared lifecycle.
const receiver = read(sharedReceiver);
assert(
  receiver.includes('ExactAlarmLifecycle.restoreAll('),
  'Shared system receiver must dispatch restoration through ExactAlarmLifecycle'
);
assert(
  !/restore\\s*\\(/.test(receiver.replace('ExactAlarmLifecycle.restoreAll(', '')),
  'Shared system receiver must not contain feature recovery implementations'
);

// ExactAlarmLifecycle is the only native restoration dispatcher entry point.
const lifecycle = read('native-android/alarm-runtime/ExactAlarmLifecycle.java');
assert(
  lifecycle.includes('public static void restoreAll('),
  'ExactAlarmLifecycle must expose the shared restoration dispatch entry point'
);
assert(
  lifecycle.includes('ExactAlarmRuntime.canScheduleExactAlarms(appContext)'),
  'ExactAlarmLifecycle must perform the single shared exact-alarm capability probe for lifecycle recovery'
);
assert(
  lifecycle.includes('adapter.restore('),
  'ExactAlarmLifecycle must dispatch recovery to feature adapters'
);
assert(
  lifecycle.includes('REASON_BOOT')
    && lifecycle.includes('REASON_TIMEZONE_CHANGED')
    && lifecycle.includes('REASON_EXACT_ALARM_PERMISSION'),
  'Lifecycle reasons must be defined centrally in ExactAlarmLifecycle'
);

// Only ExactAlarmRuntime may touch the Android AlarmManager permission API directly.
for (const rel of nativeFiles) {
  const content = read(rel);
  if (content.includes('AlarmManager')
      && content.includes('canScheduleExactAlarms()')) {
    assert(
      rel === 'native-android/alarm-runtime/ExactAlarmRuntime.java',
      'Only ExactAlarmRuntime may directly own AlarmManager.canScheduleExactAlarms(): '
        + rel
    );
  }
}

// The build/preparation flow must register exactly one shared system receiver
// and bind the three feature adapters through shared lifecycle metadata.
const prepare = read('scripts/prepare-android.mjs');
const sharedName =
  'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver';
assert(
  (prepare.match(new RegExp(sharedName.replace(/\\./g, '\\\\.'), 'g')) || []).length === 2,
  'prepare-android must contain one shared receiver name registration plus one upsert lookup'
);
assert(
  prepare.includes('app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS'),
  'prepare-android must register the shared exact-alarm feature-adapter metadata'
);
for (const adapter of [
  'app.drugtracker.autodeduction.AutoDeductionAlarmFeature',
  'app.drugtracker.criticalstock.CriticalStockAlarmAdapter',
  'app.drugtracker.alarmruntime.DoseReminderAlarmFeature',
]) {
  assert(
    prepare.includes(adapter),
    'Shared lifecycle adapter registration missing: ' + adapter
  );
}
assert(
  prepare.includes('AutoDeductionSystemReceiver')
    && prepare.includes('removeReceiverByName'),
  'prepare-android must explicitly remove the legacy Auto system receiver if it exists'
);

// Permission UI/state must come through the canonical ExactAlarm TS helper,
// which bridges to the native ExactAlarmRuntime plugin. Production source must
// not use the removed Capacitor Local Notifications exact-setting API.
const exactAlarmTs = read('src/utils/exactAlarm.ts');
assert(
  exactAlarmTs.includes('ExactAlarmRuntime.canScheduleExactAlarms()'),
  'src/utils/exactAlarm.ts must use the native ExactAlarmRuntime permission source'
);
const productionTs = listFilesRecursive('src')
  .filter((rel) => rel.endsWith('.ts') || rel.endsWith('.tsx'));
for (const rel of productionTs) {
  const content = read(rel);
  assert(
    !content.includes('checkExactNotificationSetting')
      && !content.includes('changeExactNotificationSetting'),
    'Production TypeScript must not use the removed Capacitor exact-notification permission API: '
      + rel
  );
}

// Search docs/tests/source for stale parallel lifecycle names. The legacy names
// may remain only in prepare-android removal assertions, never as a live contract.
const auditFiles = [
  ...listFilesRecursive('src'),
  ...listFilesRecursive('Tests'),
  ...listFilesRecursive('docs'),
].filter((rel) =>
  rel.endsWith('.ts')
  || rel.endsWith('.tsx')
  || rel.endsWith('.md')
);
const staleNames = [
  'AutoDeductionSystemReceiver',
  'CriticalStockSystemReceiver',
  'DoseReminderSystemReceiver',
];
for (const rel of auditFiles) {
  const content = read(rel);
  for (const stale of staleNames) {
    assert(
      !content.includes(stale),
      'Stale parallel lifecycle receiver name must not survive outside the build-time removal rule: '
        + rel
        + ' contains '
        + stale
    );
  }
}

// Runtime delivery receivers remain feature-owned and are not system lifecycle receivers.
for (const rel of [
  'native-android/auto-deduction/AutoDeductionReceiver.java',
  'native-android/critical-stock/CriticalStockAlarmReceiver.java',
  'native-android/dose-reminder/DoseReminderAlarmReceiver.java',
]) {
  const content = read(rel);
  for (const action of systemActions) {
    assert(
      !content.includes(action),
      'Feature delivery receiver must not handle Android system lifecycle action: '
        + rel
        + ' contains '
        + action
    );
  }
}

console.log('PASS: Phase 8 lifecycle + permission + recovery unification checks');
