import { describe, it, expect } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import {
  reconcileFiredEvents,
  isExactAutoOccurrenceApplied,
  exactAutoLogId,
  findExactAutoLog,
} from '../../src/utils/autoDeductionReconciliation';
import { autoDeductionOccurrenceKey } from '../../src/utils/autoDeductionNative';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { LEGACY_DOSE_ID } from '../../src/utils/notifications';
import { runAutoDeductionReconciliation } from '../../src/utils/runAutoDeductionReconciliation';
import { syncAutoDailyDeductions } from '../../src/utils/dateCalculations';
import { effectiveCurrentPills } from '../../src/utils/dateCalculations';

function baseMed(over: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSyncDate: '2026-09-14',
    autoDeductEnabled: true,
    ...over,
  };
}

function fired(
  over: Partial<AutoDeductionEvent> &
    Pick<AutoDeductionEvent, 'medicationId' | 'doseId' | 'calendarDate' | 'amount'>
): AutoDeductionEvent {
  return {
    scheduledAtEpochMs: 1,
    status: 'FIRED',
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
    ...over,
  };
}

describe('identity', () => {
  it('same med+dose+date → same key; dose/date isolated', () => {
    expect(autoDeductionOccurrenceKey('m', 'd', '2026-09-14')).toBe(
      autoDeductionOccurrenceKey('m', 'd', '2026-09-14')
    );
    expect(autoDeductionOccurrenceKey('m', 'd1', '2026-09-14')).not.toBe(
      autoDeductionOccurrenceKey('m', 'd2', '2026-09-14')
    );
    expect(autoDeductionOccurrenceKey('m', 'd', '2026-09-13')).not.toBe(
      autoDeductionOccurrenceKey('m', 'd', '2026-09-14')
    );
  });
});

describe('BLOCKER A — legacy sync ↔ native reconcile', () => {
  it('A1: lastSync settlement first → native FIRED same past day does not re-deduct', () => {
    // Simulate post-sync: stock already reduced, lastSync advanced over past day
    const med = baseMed({
      doseSchedule: [{ id: 'dose-a', amount: 2, time: '08:00' }],
      currentPills: 8,
      lastSyncDate: '2026-09-13',
      dailyDose: 2,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'dose-a',
      calendarDate: '2026-09-13',
      amount: 2,
    });
    expect(isExactAutoOccurrenceApplied(med, 'dose-a', '2026-09-13', '2026-09-14')).toBe(true);
    const r = reconcileFiredEvents([med], [], [e], { now: new Date('2026-09-14T12:00:00') });
    expect(r.details[0].outcome).toBe('already_applied');
    expect(r.medications[0].currentPills).toBe(8);
  });

  it('A2: native first records consume → historicalDayDueUnits / sync skips slot', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
      ],
      dailyDose: 3,
      currentPills: 30,
      lastSyncDate: '2026-09-12',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'b',
      calendarDate: '2026-09-13',
      amount: 2,
      scheduledAtEpochMs: 100,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.medications[0].currentPills).toBe(28);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'b', '2026-09-13')).toBe(true);
    // Sync from this state should not re-charge dose b on 2026-09-13
    const sync = syncAutoDailyDeductions(r.medications, '2026-09-14');
    const after = sync.updatedMeds[0];
    // dose b on 2026-09-13 is consumed — must not be charged again (at least no -2 for b)
    expect(after.currentPills).toBeGreaterThanOrEqual(25);
    expect(isExactAutoOccurrenceApplied(after, 'b', '2026-09-13')).toBe(true);
  });

  it('A4: multi-dose 14:00 amount=2; sibling 08:00 remains eligible', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
        { id: 'c', amount: 1, time: '22:00' },
      ],
      dailyDose: 4,
      currentPills: 20,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'b',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.medications[0].currentPills).toBe(18);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'b', '2026-09-14')).toBe(true);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'a', '2026-09-14')).toBe(false);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'c', '2026-09-14')).toBe(false);
  });

  it('A5: 08:00 applied does not mark 14:00', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
      ],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
    });
    const r = reconcileFiredEvents(
      [med],
      [],
      [fired({ medicationId: 'med-1', doseId: 'a', calendarDate: '2026-09-14', amount: 1 })]
    );
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'a', '2026-09-14')).toBe(true);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'b', '2026-09-14')).toBe(false);
  });

  it('A6: different dates isolated', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
      doseConsumptionHistory: { d: ['2026-09-13'] },
      doseConsumption: { d: '2026-09-13' },
    });
    expect(isExactAutoOccurrenceApplied(med, 'd', '2026-09-13')).toBe(true);
    expect(isExactAutoOccurrenceApplied(med, 'd', '2026-09-14')).toBe(false);
  });
});

describe('projection after exact apply', () => {
  it('currentPills and effective stay aligned (no double projection)', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 2, time: '08:00' }],
      currentPills: 10,
      lastSyncDate: '2026-09-14',
      reminderTime: '08:00',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.medications[0].currentPills).toBe(8);
    // After consume marker, todayDue should not subtract again
    const eff = effectiveCurrentPills(r.medications[0], '2026-09-14', new Date('2026-09-14T20:00:00'));
    expect(eff).toBe(8);
  });
});

describe('BLOCKER B — persistence / envelope', () => {
  it('B1: meds ok + logs fail → no mark; envelope recovery can finish', async () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 5,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    let marked = 0;
    let envelope: unknown = null;
    const out = await runAutoDeductionReconciliation({
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        marked += 1;
      },
      persistMeds: () => null,
      persistLogs: () => 'fail',
      loadEnvelope: () => envelope as never,
      saveEnvelope: (env) => {
        envelope = env;
        return null;
      },
    });
    expect(marked).toBe(0);
    expect(envelope).not.toBeNull();
    // Recovery
    const out2 = await runAutoDeductionReconciliation({
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        marked += 1;
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => envelope as never,
      saveEnvelope: (env) => {
        envelope = env;
        return null;
      },
    });
    expect(out2.recoveredEnvelope).toBe(true);
    expect(out2.medications[0].currentPills).toBe(4);
    expect(marked).toBeGreaterThan(0);
  });

  it('B3: crash after JS state before mark → retry no second deduct/log', async () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 5,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    let medsStore: Medication[] | null = null;
    let logsStore: ConsumptionLog[] | null = null;
    let marked = 0;

    const first = await runAutoDeductionReconciliation({
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        marked += 1;
        throw new Error('native mark failed');
      },
      persistMeds: (m) => {
        medsStore = m;
        return null;
      },
      persistLogs: (l) => {
        logsStore = l;
        return null;
      },
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    // When mark throws after successful persist of meds/logs, envelope cleared only after marks;
    // our finishEnvelope still tries all marks then clears. With throw, marked may be 0.
    expect(medsStore![0].currentPills).toBe(4);
    const logId = exactAutoLogId('med-1', 'd', '2026-09-14');
    expect(logsStore!.some((l) => l.id === logId)).toBe(true);

    const second = await runAutoDeductionReconciliation({
      medications: medsStore!,
      logs: logsStore!,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        marked += 1;
      },
      persistMeds: () => null,
      persistLogs: () => null,
      loadEnvelope: () => null,
      saveEnvelope: () => null,
    });
    expect(second.details[0].outcome).toBe('already_applied');
    expect(second.medications[0].currentPills).toBe(4);
    const sameLogs = second.logs.filter((l) => l.id === logId);
    expect(sameLogs.length).toBe(1);
  });

  it('B5: duplicate FIRED in batch → one stock + one log', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 5,
      lastSyncDate: '2026-09-14',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const r = reconcileFiredEvents([med], [], [e, e]);
    expect(r.medications[0].currentPills).toBe(4);
    expect(r.newExactLogs).toHaveLength(1);
    expect(r.newExactLogs[0].id).toBe(exactAutoLogId('med-1', 'd', '2026-09-14'));
  });
});

describe('deterministic log id', () => {
  it('stable across retries', () => {
    expect(exactAutoLogId('m', 'd', '2026-09-14')).toBe(exactAutoLogId('m', 'd', '2026-09-14'));
  });
});

describe('invalid / missing / disabled', () => {
  it('invalid amount no stock change', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 10,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    (e as { amount: number }).amount = NaN;
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.medications[0].currentPills).toBe(10);
  });

  it('missing med acknowledges', () => {
    const r = reconcileFiredEvents(
      [],
      [],
      [fired({ medicationId: 'gone', doseId: 'd', calendarDate: '2026-09-14', amount: 1 })]
    );
    expect(r.details[0].outcome).toBe('skipped_missing_med');
  });
});

describe('legacy identity', () => {
  it('LEGACY_DOSE_ID supported', () => {
    const med = baseMed({
      doseSchedule: undefined,
      dailyDose: 2,
      currentPills: 20,
      lastSyncDate: '2026-09-13',
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: LEGACY_DOSE_ID,
      calendarDate: '2026-09-14',
      amount: 2,
    });
    // lastSync 09-13, today 09-14: not settled for today
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(18);
  });
});
