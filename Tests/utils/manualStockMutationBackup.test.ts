import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsumptionLog, Medication } from '../../src/types';

const mocks = vi.hoisted(() => ({
  runManualStockTransaction: vi.fn(),
  commitWithManualEnvelope: vi.fn(),
  invalidateMedicationRecurrences: vi.fn(),
  invalidateMedicationDoseReminders: vi.fn(),
  restoreInvalidatedRecurrences: vi.fn(),
  restoreInvalidatedDoseReminders: vi.fn(),
}));

vi.mock('../../src/utils/manualStockTransaction', () => ({
  runManualStockTransaction: mocks.runManualStockTransaction,
  commitWithManualEnvelope: mocks.commitWithManualEnvelope,
}));

vi.mock('../../src/utils/manualStockMutationShared', () => ({
  invalidateMedicationRecurrences: mocks.invalidateMedicationRecurrences,
  invalidateMedicationDoseReminders: mocks.invalidateMedicationDoseReminders,
  restoreInvalidatedRecurrences: mocks.restoreInvalidatedRecurrences,
  restoreInvalidatedDoseReminders: mocks.restoreInvalidatedDoseReminders,
}));

import { runGatedBackupRestore } from '../../src/utils/manualStockMutationBackup';

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 20,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    reminderEnabled: true,
    doseSchedule: [{ id: 'dose-1', amount: 1, time: '08:00' }],
    ...over,
  };
}

const log: ConsumptionLog = {
  id: 'log-1',
  medicationId: 'med-1',
  medicationName: 'TestMed',
  type: 'dose_taken',
  amount: -1,
  date: '2026-09-27',
  timestamp: '2026-09-27T08:05:00.000Z',
  description: 'take',
};

describe('runGatedBackupRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.runManualStockTransaction.mockImplementation(async (options) =>
      options.operation({
        fresh: {
          medications: [med()],
          logs: [log],
          globalAutoDeductEnabled: true,
        },
        todayStr: '2026-09-27',
        now: new Date('2026-09-27T12:00:00.000Z'),
      })
    );
    mocks.commitWithManualEnvelope.mockResolvedValue(null);
    mocks.invalidateMedicationRecurrences.mockResolvedValue({
      ok: true,
      invalidatedDoseIds: ['dose-1'],
      invalidated: [{ doseId: 'dose-1', generation: 7 }],
    });
    mocks.invalidateMedicationDoseReminders.mockResolvedValue({ ok: true });
    mocks.restoreInvalidatedRecurrences.mockResolvedValue({ ok: true });
    mocks.restoreInvalidatedDoseReminders.mockResolvedValue({ ok: true });
  });

  it('restores invalidated Auto and Dose definitions when durable commit fails', async () => {
    mocks.commitWithManualEnvelope.mockResolvedValue('persist_failed');

    const result = await runGatedBackupRestore({
      backupMedications: [med({ id: 'backup-med', name: 'BackupMed' })],
      backupLogs: [],
      restoreLogs: true,
      mode: 'replace',
    });

    expect(result.outcome).toBe('persist_failed');
    expect(result.logs).toEqual([log]);
    expect(mocks.restoreInvalidatedDoseReminders).toHaveBeenCalledWith(med());
    expect(mocks.restoreInvalidatedRecurrences).toHaveBeenCalledWith(med(), [
      { doseId: 'dose-1', generation: 7 },
    ]);
  });

  it('replaces existing logs with an explicitly empty backup', async () => {
    const result = await runGatedBackupRestore({
      backupMedications: [med({ id: 'backup-med', name: 'BackupMed' })],
      backupLogs: [],
      restoreLogs: true,
      mode: 'replace',
    });

    expect(result.outcome).toBe('applied');
    expect(result.logs).toEqual([]);
    expect(mocks.commitWithManualEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        logs: [],
      }),
      expect.any(Array)
    );
  });

  it('rejects merge mappings that would assign two backup medications to one existing medication', async () => {
    const result = await runGatedBackupRestore({
      backupMedications: [
        med({ id: 'med-1', name: 'RenamedMed' }),
        med({ id: 'backup-2', name: 'TestMed' }),
      ],
      backupLogs: [],
      restoreLogs: false,
      mode: 'merge',
    });

    expect(result.outcome).toBe('persist_failed');
    expect(result.reason).toBe('duplicate_restore_medication_target');
    expect(mocks.commitWithManualEnvelope).not.toHaveBeenCalled();
    expect(mocks.restoreInvalidatedDoseReminders).toHaveBeenCalledWith(med());
    expect(mocks.restoreInvalidatedRecurrences).toHaveBeenCalledWith(med(), [
      { doseId: 'dose-1', generation: 7 },
    ]);
  });
});
