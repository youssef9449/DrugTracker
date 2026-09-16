/**
 * Issue #242 — public bridge must not hide list failures as successful [].
 * Mocks only the Capacitor plugin surface; exercises real listScheduledAutoDeductionOccurrences.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listScheduledOccurrences = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
  },
  registerPlugin: () => ({
    listScheduledOccurrences: (...args: unknown[]) =>
      listScheduledOccurrences(...args),
    scheduleOccurrence: vi.fn(),
    cancelOccurrence: vi.fn(),
    invalidateRecurrenceAuthorization: vi.fn(),
    listFiredEvents: vi.fn(),
    listEvents: vi.fn(),
    markReconciled: vi.fn(),
    canScheduleExactAlarms: vi.fn(),
    restoreFutureSchedules: vi.fn(),
  }),
}));

import { listScheduledAutoDeductionOccurrences } from '../../src/utils/autoDeductionNative';

describe('listScheduledAutoDeductionOccurrences bridge (Issue #242)', () => {
  beforeEach(() => {
    listScheduledOccurrences.mockReset();
  });

  it('successful empty native list → ok:true schedules:[]', async () => {
    listScheduledOccurrences.mockResolvedValue({ schedules: [] });
    const result = await listScheduledAutoDeductionOccurrences();
    expect(result).toEqual({ ok: true, schedules: [] });
  });

  it('native reject → ok:false with error (not successful empty)', async () => {
    listScheduledOccurrences.mockRejectedValue(new Error('native_binder_dead'));
    const result = await listScheduledAutoDeductionOccurrences();
    expect(result.ok).toBe(false);
    expect(result.schedules).toEqual([]);
    expect(result.error).toBe('native_binder_dead');
  });

  it('non-Error reject → stable list_schedules_failed', async () => {
    listScheduledOccurrences.mockRejectedValue('boom');
    const result = await listScheduledAutoDeductionOccurrences();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('list_schedules_failed');
  });

  it('successful non-empty list preserves schedules', async () => {
    const schedules = [
      {
        medicationId: 'm1',
        doseId: 'd1',
        calendarDate: '2099-01-01',
      },
    ];
    listScheduledOccurrences.mockResolvedValue({ schedules });
    const result = await listScheduledAutoDeductionOccurrences();
    expect(result.ok).toBe(true);
    expect(result.schedules).toEqual(schedules);
  });
});
