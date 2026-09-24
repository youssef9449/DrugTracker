/**
 * Group 6 structural checks for detached async command boundaries.
 * Run directly with Node; no npm/npx required.
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

const helper = read('src/utils/async/runAsyncCommand.ts');
assert(
  helper.includes('export function runAsyncCommand')
    && helper.includes('.catch(')
    && helper.includes('console.warn'),
  'shared async command boundary must provide terminal rejection logging'
);

const handlers = [
  'src/hooks/useNativeActionHandlers.ts',
  'src/hooks/useMedicationAlarmHandlers.ts',
  'src/hooks/useMedicationAutoHandlers.ts',
  'src/hooks/useMedicationNotificationHandlers.ts',
];

for (const file of handlers) {
  const content = read(file);
  assert(
    content.includes('runAsyncCommand'),
    'handler must use the shared async command boundary: ' + file
  );
  assert(
    !content.includes('void (async () =>'),
    'handler must not detach an async IIFE directly: ' + file
  );
  assert(
    !content.includes('void isDoseReminderOccurrenceOwned(')
      && !content.includes('void retryPersistedNotificationDeliveries()')
      && !content.includes('void runAlarmTake(')
      && !content.includes('void cancelNotification('),
    'handler contains an unbounded detached async operation: ' + file
  );
}

console.log('PASS: Group 6 async command boundary checks');
