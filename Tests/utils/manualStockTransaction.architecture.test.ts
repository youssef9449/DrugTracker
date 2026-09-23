import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const manualSource = fs.readFileSync(
  path.join(ROOT, 'src/utils/manualStockMutation.ts'),
  'utf8'
);
const transactionSource = fs.readFileSync(
  path.join(ROOT, 'src/utils/manualStockTransaction.ts'),
  'utf8'
);

describe('Manual Stock transaction architecture', () => {
  it('routes every manual mutation through the shared transaction pipeline', () => {
    const operations = [
      'runGatedManualConsume',
      'runGatedManualRestore',
      'runGatedAddMedication',
      'runGatedRefill',
      'runGatedUndoRefill',
      'runGatedAutoDeductToggle',
      'runGatedGlobalAutoDeductToggle',
      'runGatedDeleteMedication',
      'runGatedMedicationNotificationToggle',
      'runGatedMedicationUpdate',
    ];

    for (const operation of operations) {
      const start = manualSource.indexOf('export function ' + operation);
      const next = manualSource.indexOf('export function runGated', start + 10);
      const body = manualSource.slice(start, next < 0 ? manualSource.length : next);
      expect(body).toContain('runManualStockTransaction');
      expect(body).not.toContain('withAutoStockMutationGate');
    }
  });

  it('keeps native delta construction and durable finalization in the shared pipeline', () => {
    expect(manualSource).not.toContain('function buildNativeStockDeltas');
    expect(manualSource).not.toContain('applyForegroundAutoStockDeltas(');
    expect(transactionSource).toContain('function buildNativeStockDeltas');
    expect(transactionSource).toContain('applyForegroundAutoStockDeltas(');
    expect(transactionSource).toContain('commitDurableAutoStockState(');
  });
});
