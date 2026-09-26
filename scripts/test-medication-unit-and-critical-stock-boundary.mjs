import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

function collectProductionSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectProductionSourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const productionFiles = collectProductionSourceFiles('src').filter(
  (path) => !path.startsWith('src/constants/medicationDefaults.')
);

const constant = read('src/constants/medicationDefaults.ts');
if (!constant.includes("export const DEFAULT_MEDICATION_UNIT = 'قرص';")) {
  throw new Error('DEFAULT_MEDICATION_UNIT must remain the single domain default');
}

const inlineDefaultPattern =
  /(?:unit\s*(?::\s*string\s*)?=\s*|unit\s*\|\|\s*|unit\s*\?\?\s*)['"]قرص['"]/;

for (const path of productionFiles) {
  const source = read(path);
  if (inlineDefaultPattern.test(source)) {
    throw new Error('Inline medication unit default remains in ' + relative(root, join(root, path)));
  }
}

const newMedicationForm = read('src/hooks/addMedicationFormReducer.ts');
if (!newMedicationForm.includes('unit: DEFAULT_MEDICATION_UNIT')) {
  throw new Error('New medication form must use DEFAULT_MEDICATION_UNIT');
}

const nativeProductionFiles = [
  'native-android/dose-reminder/DoseReminderPlugin.java',
  'native-android/dose-reminder/DoseReminderAlarmReceiver.java',
  'native-android/alarm-runtime/DoseReminderAlarmFeature.java',
  'native-android/critical-stock/CriticalStockAlarmAdapter.java',
];

for (const path of nativeProductionFiles) {
  const source = read(path);
  if (
    source.includes('getString("unit", "قرص")') ||
    source.includes('optString("unit", "قرص")') ||
    source.includes('unit == null ? "قرص" : unit')
  ) {
    throw new Error('Native medication unit fallback remains in ' + path);
  }
}

const receiver = read('native-android/critical-stock/CriticalStockAlarmReceiver.java');
const adapter = read('native-android/critical-stock/CriticalStockAlarmAdapter.java');
const postIndex = receiver.indexOf('new NotificationRuntime(appContext).post(');
if (receiver.includes('ExactAlarmRuntime.runWithOperationLock(')) {
  throw new Error('Critical Stock receiver must not hold the shared alarm lock during delivery I/O');
}
if (
  postIndex < 0 ||
  receiver.indexOf('claimOneShotDelivery(') < 0 ||
  receiver.indexOf('markOneShotDelivered(') < postIndex
) {
  throw new Error(
    'Critical Stock delivery must claim before I/O and persist evidence after accepted I/O'
  );
}
if (!adapter.includes('ACTIVE_DELIVERY_CLAIMS') || !adapter.includes('runtime.ownsActiveSchedule(')) {
  throw new Error(
    'Critical Stock delivery ownership must remain feature-local and operation-version guarded'
  );
}
if (!adapter.includes('unit.isEmpty() ? "unit" : null')) {
  throw new Error('Critical Stock restore must reject missing medication unit metadata');
}

const dosePlugin = read('native-android/dose-reminder/DoseReminderPlugin.java');
if (!dosePlugin.includes('unit == null || unit.trim().isEmpty()')) {
  throw new Error('Dose Reminder bridge must require an explicit medication unit');
}

console.log('Medication unit default and Critical Stock lock-boundary checks passed.');
