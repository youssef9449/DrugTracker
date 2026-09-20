/**
 * Structural regression checks for the Phase 4 Auto Deduction scheduling boundary.
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

assert(
  !scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmRuntime'),
  'business scheduler must not import ExactAlarmRuntime'
);
assert(
  scheduler.includes('import app.drugtracker.alarmruntime.ExactAlarmStore;'),
  'Auto business recovery may use the shared durable schedule store directly'
);
assert(
  !scheduler.includes('new ExactAlarmRuntime('),
  'business scheduler must not construct ExactAlarmRuntime'
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
