import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());

const facadeSource = fs.readFileSync(
  path.join(ROOT, 'src/utils/manualStockMutation.ts'),
  'utf8'
);
const transactionSource = fs.readFileSync(
  path.join(ROOT, 'src/utils/manualStockTransaction.ts'),
  'utf8'
);

const familyModules = {
  consumeRestore: fs.readFileSync(
    path.join(ROOT, 'src/utils/manualStockMutationConsumeRestore.ts'),
    'utf8'
  ),
  inventory: fs.readFileSync(
    path.join(ROOT, 'src/utils/manualStockMutationInventory.ts'),
    'utf8'
  ),
  medication: fs.readFileSync(
    path.join(ROOT, 'src/utils/manualStockMutationMedication.ts'),
    'utf8'
  ),
  preferences: fs.readFileSync(
    path.join(ROOT, 'src/utils/manualStockMutationPreferences.ts'),
    'utf8'
  ),
} as const;

describe('Manual Stock transaction architecture', () => {
  it('keeps the public facade thin and assigns each mutation family to a focused module', () => {
    const ownership: Record<string, string[]> = {
      consumeRestore: [
        'runGatedManualConsume',
        'runGatedManualRestore',
      ],
      inventory: [
        'runGatedRefill',
        'runGatedUndoRefill',
      ],
      medication: [
        'runGatedAddMedication',
        'runGatedDeleteMedication',
        'runGatedMedicationUpdate',
      ],
      preferences: [
        'runGatedAutoDeductToggle',
        'runGatedGlobalAutoDeductToggle',
        'runGatedMedicationNotificationToggle',
      ],
    };

    for (const operation of Object.values(ownership).flat()) {
      expect(facadeSource).toContain(operation);
      expect(facadeSource).not.toContain(
        'export function ' + operation
      );
    }

    for (const [family, operations] of Object.entries(ownership)) {
      const source = familyModules[family as keyof typeof familyModules];
      for (const operation of operations) {
        expect(source).toContain('export function ' + operation);
        expect(source).toContain('runManualStockTransaction');
      }
    }
  });

  it('keeps native delta construction and durable finalization in the shared pipeline', () => {
    expect(facadeSource).not.toContain('function buildNativeStockDeltas');
    expect(facadeSource).not.toContain('applyForegroundAutoStockDeltas(');
    expect(transactionSource).toContain('function buildNativeStockDeltas');
    expect(transactionSource).toContain('applyForegroundAutoStockDeltas(');
    expect(transactionSource).toContain('commitDurableAutoStockState(');
  });
});
