import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

const productionFiles = [
  'src/hooks/useStockAlerts.ts',
  'src/hooks/useDoseReminders.ts',
  'src/utils/medicationPackaging.ts',
  'src/utils/doseReminderDefinitions.ts',
  'src/hooks/addMedicationFormReducer.ts',
  'src/hooks/useCriticalAlarmScheduler.ts',
  'src/components/medicationCardParts.tsx',
  'src/components/MedicationCardViews.tsx',
  'src/components/SelectDoseModal.tsx',
];

const constant = read('src/constants/medicationDefaults.ts');
if (!constant.includes("export const DEFAULT_MEDICATION_UNIT = 'قرص';")) {
  throw new Error('DEFAULT_MEDICATION_UNIT must remain the single domain default');
}

for (const path of productionFiles) {
  const source = read(path);
  if (source.includes("unit || 'قرص'") || source.includes("unit: string = 'قرص'")) {
    throw new Error('Inline medication unit default remains in ' + path);
  }
  if (!source.includes('DEFAULT_MEDICATION_UNIT')) {
    throw new Error('Missing centralized unit default import/use in ' + path);
  }
}

const receiver = read('native-android/critical-stock/CriticalStockAlarmReceiver.java');
const adapter = read('native-android/critical-stock/CriticalStockAlarmAdapter.java');
const postIndex = receiver.indexOf('new NotificationRuntime(appContext).post(');
if (receiver.includes('ExactAlarmRuntime.runWithOperationLock(')) {
  throw new Error('Critical Stock receiver must not hold the shared alarm lock during delivery I/O');
}
if (postIndex < 0 || receiver.indexOf('claimOneShotDelivery(') < 0 || receiver.indexOf('markOneShotDelivered(') < postIndex) {
  throw new Error('Critical Stock delivery must claim before I/O and persist evidence after accepted I/O');
}
if (!adapter.includes('ACTIVE_DELIVERY_CLAIMS') || !adapter.includes('runtime.ownsActiveSchedule(')) {
  throw new Error('Critical Stock delivery ownership must remain feature-local and operation-version guarded');
}

console.log('Medication unit default and Critical Stock lock-boundary checks passed.');
