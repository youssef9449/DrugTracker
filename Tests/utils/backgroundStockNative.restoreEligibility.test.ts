import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';

const nativeSync = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
  },
  registerPlugin: () => ({
    syncBackgroundStock: (...args: unknown[]) => nativeSync(...args),
    repairBackgroundStockFromFiredEvents: vi.fn(),
    getBackgroundStockSnapshot: vi.fn(),
  }),
}));

import { syncBackgroundStock } from '../../src/utils/backgroundStockNative';

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 10,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    ...over,
  };
}

describe('background stock restore occurrence classification', () => {
  beforeEach(() => {
    nativeSync.mockReset();
    nativeSync.mockResolvedValue({
      ok: true,
      backgroundVersion: 1,
      currentPillsByMedication: { 'med-1': 10 },
    });
  });

  it('does not treat a skipped_day Restore log alone as already-applied', async () => {
    const occurrence = 'med-1\u001fd1\u001f2026-09-21';
    const logs: ConsumptionLog[] = [
      {
        id: 'restore-1',
        medicationId: 'med-1',
        medicationName: 'TestMed',
        type: 'skipped_day',
        amount: 2,
        date: '2026-09-21',
        timestamp: '2026-09-21T08:00:00.000Z',
        description: 'restore',
        doseId: 'd1',
      },
    ];

    await syncBackgroundStock([med({
      doseSchedule: [{ id: 'd1', amount: 2, time: '12:00' }],
    })], logs);

    const options = nativeSync.mock.calls[0][0] as {
      alreadyAppliedOccurrences: string[];
      jsRestoreOccurrences: string[];
    };

    expect(options.alreadyAppliedOccurrences).not.toContain(occurrence);
    expect(options.jsRestoreOccurrences).toContain(occurrence);
  });

  it('keeps a durable skip-history occurrence blocked', async () => {
    const occurrence = 'med-1\u001fd1\u001f2026-09-21';

    await syncBackgroundStock([
      med({
        doseSchedule: [{ id: 'd1', amount: 2, time: '12:00' }],
        doseSkippedHistory: { d1: ['2026-09-21'] },
      }),
    ]);

    const options = nativeSync.mock.calls[0][0] as {
      alreadyAppliedOccurrences: string[];
      jsRestoreOccurrences: string[];
    };

    expect(options.alreadyAppliedOccurrences).toContain(occurrence);
    expect(options.jsRestoreOccurrences).toContain(occurrence);
  });
});
