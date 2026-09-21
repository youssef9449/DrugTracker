/**
 * Structural regression checks for the Phase 2 Auto Deduction scheduling boundary.
 * Run: node scripts/test-auto-deduction-scheduling-adapter.mjs
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

const scheduler = read('native-android/auto-deduction/AutoDeductionScheduler.java');
const adapter = read('native-android/auto-deduction/AutoDeductionSchedulingAdapter.java');
const prepare = read('scripts/prepare-android.mjs');
const gradle = read('native-android/jvm-tests/build.gradle');
const runtime = read('native-android/alarm-runtime/ExactAlarmRuntime.java');
const store = read('native-android/alarm-runtime/ExactAlarmStore.java');
const lock = read('native-android/alarm-runtime/ExactAlarmOperationLock.java');

assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmRuntime'),
  'business scheduler must not import ExactAlarmRuntime'
);
assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmStore;'),
  'Auto business scheduler must not import the shared alarm store'
);
assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmOperationLock;'),
  'Auto business scheduler must not import the shared alarm operation lock'
);
assert(
  !runtime.includes('ExactAlarmStore store()'),
  'ExactAlarmRuntime must not expose the shared store'
);
assert(
  !store.includes('public final class ExactAlarmStore'),
  'ExactAlarmStore must remain internal to the alarm-runtime package'
);
assert(
  !lock.includes('public final class ExactAlarmOperationLock'),
  'ExactAlarmOperationLock must remain internal to the alarm-runtime package'
);
assert(
  !scheduler.includes('schedulePrefs'),
  'Auto business scheduler must not access shared alarm schedule SharedPreferences'
);
assert(
  !scheduler.includes('scheduleStore'),
  'Auto business scheduler must not own the shared alarm store'
);
assert(
  !scheduler.includes('FIELD_FIRE_RETRY_COUNT'),
  'Auto shared schedule metadata must not have a fireRetryCount field'
);
assert(
  !scheduler.includes('current.put("fireRetryCount"'),
  'Auto shared schedule metadata must not persist the retry counter'
);
assert(
  !scheduler.includes('new ExactAlarmRuntime('),
  'business scheduler must not construct ExactAlarmRuntime'
);
assert(
  !scheduler.includes('ExactAlarmOperationLock.LOCK'),
  'business scheduler must use its own feature-owned serialization lock'
);

assert(
  !scheduler.includes('alarmRuntime.'),
  'business scheduler must not call the shared runtime directly'
);
assert(
  adapter.includes('import app.drugtracker.alarmruntime.ExactAlarmRuntime;'),
  'scheduling adapter must own the ExactAlarmRuntime dependency'
);
assert(
  !adapter.includes('ExactAlarmStore'),
  'scheduling adapter must not become an ExactAlarmStore facade'
);
assert(
  !adapter.includes('SharedPreferences'),
  'scheduling adapter must not own schedule SharedPreferences'
);
assert(
  !adapter.includes('schedulePrefs'),
  'scheduling adapter must not own durable schedule preference access'
);
assert(
  adapter.includes('alarmRuntime.getScheduleRaw('),
  'scheduling adapter must expose schedule reads through ExactAlarmRuntime'
);
assert(
  adapter.includes('alarmRuntime.listScheduleMetadata('),
  'scheduling adapter must expose schedule snapshots through ExactAlarmRuntime'
);
assert(
  adapter.includes('alarmRuntime.removeScheduleIfOwned('),
  'scheduling adapter must expose ownership-safe removal through ExactAlarmRuntime'
);
assert(
  adapter.includes('alarmRuntime.isEffectivelyCancelled('),
  'scheduling adapter must expose cancellation state through ExactAlarmRuntime'
);

assert(
  adapter.includes('alarmRuntime.schedule('),
  'scheduling adapter must delegate durable occurrence scheduling'
);
assert(
  adapter.includes('alarmRuntime.cancel('),
  'scheduling adapter must delegate occurrence cancellation'
);
assert(
  adapter.includes('alarmRuntime.scheduleOneShot('),
  'scheduling adapter must delegate feature retry alarm installation'
);
assert(
  adapter.includes('AutoDeductionContract.occurrenceUri('),
  'scheduling adapter must translate Auto occurrence identity'
);
assert(
  adapter.includes('EXTRA_RECURRENCE_GENERATION'),
  'scheduling adapter must carry Auto recurrence authorization into delivery metadata'
);

assert(
  prepare.includes("'AutoDeductionSchedulingAdapter.java'"),
  'Android preparation must copy the scheduling adapter source'
);
assert(
  gradle.includes('"AutoDeductionSchedulingAdapter.java"'),
  'JVM test source set must compile the scheduling adapter'
);

console.log('PASS: Auto Deduction scheduling adapter boundary checks');
