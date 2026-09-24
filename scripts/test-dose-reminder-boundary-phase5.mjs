/**
 * Phase 5 structural regression guard for the Dose Reminder boundary.
 * Run directly with Node; no npm/npx required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function assert(condition, message) {
  if (!condition) { console.error('FAIL:', message); process.exit(1); }
}

const productionDoseFiles = [
  'src/hooks/useDoseReminders.ts',
  'src/hooks/useNativeActionHandlers.ts',
  'src/hooks/useDoseReminderScheduler.ts',
  'src/utils/doseReminderNative.ts',
  'src/utils/doseReminderScheduling.ts',
  'src/utils/notifications/doseReminderNotifications.ts',
  'native-android/dose-reminder/DoseReminderAlarmAdapter.java',
  'native-android/dose-reminder/DoseReminderAlarmReceiver.java',
  'native-android/dose-reminder/DoseReminderPlugin.java',
  'native-android/alarm-runtime/DoseReminderAlarmFeature.java',
];

for (const file of productionDoseFiles) {
  const content = read(file);
  assert(
    !content.includes('autoDeductEnabled') && !content.includes('AutoDeduction'),
    'Dose production path contains Auto business coupling: ' + file
  );
  assert(
    content.includes('allowManualTakeAction'),
    'Dose production path is missing the neutral capability: ' + file
  );
}

const app = read('src/App.tsx');
const scheduler = read('src/hooks/useDoseReminderScheduler.ts');
const controller = read('src/hooks/useDoseReminders.ts');
const handlers = read('src/hooks/useNativeActionHandlers.ts');
const adapter = read('native-android/dose-reminder/DoseReminderAlarmAdapter.java');
const receiver = read('native-android/dose-reminder/DoseReminderAlarmReceiver.java');
const plugin = read('native-android/dose-reminder/DoseReminderPlugin.java');
const lifecycle = read('native-android/alarm-runtime/DoseReminderAlarmFeature.java');
const runtime = read('native-android/alarm-runtime/ExactAlarmRuntime.java');

assert(
  app.includes('allowManualTakeActionByMedicationId') &&
  app.includes('medication.autoDeductEnabled === false'),
  'App/business layer must translate its own policy into the neutral capability'
);
assert(
  scheduler.includes('allowManualTakeActionByMedicationId') &&
  scheduler.includes('allowManualTakeAction'),
  'Dose scheduler must consume only the neutral capability'
);
assert(
  controller.includes('allowManualTakeActionByMedicationId'),
  'In-app Dose Reminder controller must consume only the neutral capability'
);
assert(
  handlers.includes('allowManualTakeActionByMedicationId'),
  'Native foreground handler must consume only the neutral capability'
);
assert(
  adapter.includes('ExactAlarmRuntime') &&
  adapter.includes('allowManualTakeAction') &&
  !adapter.includes('AlarmManager') &&
  !adapter.includes('PendingIntent'),
  'Dose adapter must use the shared runtime without direct alarm mechanics'
);
assert(
  receiver.includes('allowManualTakeAction') &&
  receiver.includes('NotificationRuntime') &&
  receiver.includes('scheduleNextDay'),
  'Dose receiver must keep delivery/recurrence in the Dose boundary'
);
assert(
  plugin.includes('allowManualTakeAction') &&
  lifecycle.includes('allowManualTakeAction'),
  'Dose native bridge/lifecycle must use the neutral capability'
);
assert(
  runtime.includes('AlarmManager') &&
  !runtime.includes('allowManualTakeAction') &&
  !runtime.includes('AutoDeduction'),
  'Shared ExactAlarmRuntime must remain mechanism-only'
);
console.log('PASS: Phase 5 Dose Reminder boundary checks');
