/**
 * Structural regression checks for the Phase 4 Critical Stock boundary.
 * Run: node scripts/test-critical-stock-boundary-phase4.mjs
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

const criticalDir = path.join(root, 'native-android', 'critical-stock');
const criticalJavaFiles = fs
  .readdirSync(criticalDir)
  .filter((name) => name.endsWith('.java'));

const adapter = read('native-android/critical-stock/CriticalStockAlarmAdapter.java');
const receiver = read('native-android/critical-stock/CriticalStockAlarmReceiver.java');
const plugin = read('native-android/critical-stock/CriticalStockPlugin.java');
const criticalProjection = read('src/utils/date/criticalProjection.ts');
const dateCalculations = read('src/utils/dateCalculations.ts');
const criticalScheduler = read('src/hooks/useCriticalAlarmScheduler.ts');
const criticalScheduling = read('src/utils/criticalAlarmScheduling.ts');
const prepare = read('scripts/prepare-android.mjs');
const alarmRuntime = read('native-android/alarm-runtime/ExactAlarmRuntime.java');
const alarmContract = read('native-android/alarm-runtime/ExactAlarmContract.java');
const alarmLifecycle = read('native-android/alarm-runtime/ExactAlarmLifecycle.java');

assert(
  criticalJavaFiles.length === 3
    && criticalJavaFiles.includes('CriticalStockAlarmAdapter.java')
    && criticalJavaFiles.includes('CriticalStockAlarmReceiver.java')
    && criticalJavaFiles.includes('CriticalStockPlugin.java'),
  'Critical Stock native surface must contain only adapter, private receiver, and Capacitor bridge'
);

for (const file of criticalJavaFiles) {
  const content = read('native-android/critical-stock/' + file);
  assert(
    !content.includes('AutoDeductionScheduler')
      && !content.includes('AutoDeductionEventStore')
      && !content.includes('AutoDeductionAlarmFeature'),
    'Critical production code must not depend on Auto Deduction internals: ' + file
  );
  assert(
    !content.includes('PREFS_FIRE_RETRY')
      && !content.includes('PREFS_RECURRENCE_AUTH')
      && !content.includes('EXTRA_RECURRENCE_GENERATION')
      && !content.includes('fireRetryCount'),
    'Critical production code must not own Auto recurrence/retry state: ' + file
  );
}

assert(
  adapter.includes('implements ExactAlarmFeatureAdapter'),
  'CriticalStockAlarmAdapter must remain the single Critical lifecycle boundary'
);
assert(
  adapter.includes('import app.drugtracker.alarmruntime.ExactAlarmRuntime;')
    && adapter.includes('new ExactAlarmRuntime('),
  'CriticalStockAlarmAdapter must use the shared ExactAlarmRuntime'
);
assert(
  !adapter.includes('import android.app.AlarmManager;')
    && !adapter.includes('import android.app.PendingIntent;')
    && !adapter.includes('Context.ALARM_SERVICE'),
  'CriticalStockAlarmAdapter must not duplicate AlarmManager/PendingIntent mechanics'
);
assert(
  !adapter.includes('synchronized (ExactAlarmOperationLock.LOCK)')
    && !adapter.includes('ExactAlarmStore'),
  'CriticalStockAlarmAdapter must not duplicate the shared store/lock'
);
assert(
  !adapter.includes('اقترب النفاد الحرج')
    && !adapter.includes('دخل مرحلة النفاد الحرج'),
  'Critical notification wording must remain in Critical business/notification code, not the native adapter'
);

assert(
  receiver.includes('import app.drugtracker.notificationruntime.NotificationRuntime;')
    && receiver.includes('new NotificationRuntime('),
  'CriticalStockAlarmReceiver must deliver through NotificationRuntime'
);
assert(
  !receiver.includes('AutoDeductionScheduler')
    && !receiver.includes('AutoDeductionEventStore')
    && !receiver.includes('PREFS_FIRE_RETRY')
    && !receiver.includes('PREFS_RECURRENCE_AUTH'),
  'Critical receiver must not depend on Auto business/recovery state'
);

// #488: the canonical Critical crossing calculation lives in the dedicated
// Critical business module (src/utils/date/criticalProjection.ts) after the
// PR #554 split — the gate asserts the REAL location, not the old mixed
// dateCalculations.ts file. The old file may still re-export it for
// import compatibility, but the DEFINITION must live in the canonical
// module only.
assert(
  criticalProjection.includes('export function getCriticalAlarmDate('),
  'getCriticalAlarmDate must be defined in the canonical Critical business calculation module (src/utils/date/criticalProjection.ts)'
);
assert(
  !/export function getCriticalAlarmDate\(/.test(dateCalculations),
  'dateCalculations.ts must not re-implement getCriticalAlarmDate (single canonical definition)'
);
assert(
  criticalProjection.includes("from '../medicationDomain'")
    || criticalProjection.includes("from './medicationDomain'"),
  'criticalProjection must consume the shared medication-domain primitives'
);
assert(
  criticalScheduler.includes('getCriticalAlarmDate('),
  'Critical scheduler must use the business crossing calculation'
);
assert(
  !alarmRuntime.includes('getCriticalAlarmDate')
    && !alarmRuntime.includes('criticalThresholdDays')
    && !alarmRuntime.includes('warningThresholdDays'),
  'Shared exact-alarm runtime must not contain Critical crossing/projection logic'
);
assert(
  criticalScheduling.includes('scheduleCriticalAlarmNative(')
    && criticalScheduling.includes('cancelCriticalAlarmNative(')
    && criticalScheduling.includes('verifyCriticalAlarmPendingNative('),
  'Critical exact scheduler must cross into the native adapter through the Critical native bridge'
);

assert(
  prepare.includes("path.join(root, 'native-android', 'critical-stock')")
    && prepare.includes('syncJavaSourceSet('),
  'Android preparation must synchronize the complete Critical Stock source directory'
);
assert(
  !prepare.includes("'CriticalStockAlarmFeature.java'")
    && !prepare.includes('app.drugtracker.alarmruntime.CriticalStockAlarmFeature'),
  'No Critical feature class may be installed into the shared alarm-runtime package'
);

const sharedAlarmRuntime = fs
  .readdirSync(path.join(root, 'native-android', 'alarm-runtime'))
  .filter((name) => name.endsWith('.java'));
assert(
  sharedAlarmRuntime.every((name) => !name.includes('CriticalStock')),
  'Critical Stock files must not exist in the shared alarm-runtime source directory'
);

assert(
  !alarmContract.includes('CriticalStock')
    && !alarmLifecycle.includes('CriticalStock'),
  'Shared contract/lifecycle must remain Critical-feature neutral'
);

const adapterPublicSchedule = (adapter.match(/public ScheduleResult schedule\(/g) || []).length;
const adapterPublicCancel = (adapter.match(/public CancelResult cancel\(/g) || []).length;
const adapterPublicVerify = (adapter.match(/public boolean verify\(/g) || []).length;
assert(
  adapterPublicSchedule === 1 && adapterPublicCancel === 1 && adapterPublicVerify === 1,
  'Critical adapter must expose exactly one schedule/cancel/verify scheduler-facing surface'
);

assert(
  criticalScheduler.includes('loadCriticalNotificationClaims')
    && criticalScheduler.includes('getCriticalNotificationClaim')
    && criticalScheduler.includes('bumpCriticalAlarmGeneration')
    && criticalScheduler.includes('currentCriticalAlarmGeneration'),
  'Critical business scheduler must own claim/generation semantics'
);

console.log('PASS: Phase 4 Critical Stock boundary checks');
