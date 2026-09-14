import { describe, it, expect } from 'vitest';
import type { Medication, ConsumptionLog } from '../../src/types';
import {
  reconcileFiredEvents,
  applyExactAutoEventToMedication,
  isExactAutoOccurrenceApplied,
} from '../../src/utils/autoDeductionReconciliation';
import { autoDeductionOccurrenceKey } from '../../src/utils/autoDeductionNative';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNative';
import { LEGACY_DOSE_ID } from '../../src/utils/notifications';
import {
  runAutoDeductionReconciliation,
} from '../../src/utils/runAutoDeductionReconciliation';
import {
  conditionalRollback,
  buildSchedulePayload,
} from '../../src/utils/autoDeductionScheduleOwnership';

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
  over: Partial<AutoDeductionEvent> & Pick<AutoDeductionEvent, 'medicationId' | 'doseId' | 'calendarDate' | 'amount'>
): AutoDeductionEvent {
  return {
    scheduledAtEpochMs: 1,
    status: 'FIRED',
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
    ...over,
  };
}

describe('occurrence identity', () => {
  it('same med+dose+date → same key', () => {
    expect(autoDeductionOccurrenceKey('m', 'd', '2026-09-14')).toBe(
      autoDeductionOccurrenceKey('m', 'd', '2026-09-14')
    );
  });
  it('different dose or date → different key', () => {
    expect(autoDeductionOccurrenceKey('m', 'd1', '2026-09-14')).not.toBe(
      autoDeductionOccurrenceKey('m', 'd2', '2026-09-14')
    );
    expect(autoDeductionOccurrenceKey('m', 'd', '2026-09-13')).not.toBe(
      autoDeductionOccurrenceKey('m', 'd', '2026-09-14')
    );
  });
});

describe('reconcileFiredEvents — apply once', () => {
  it('FIRED + no marker → one deduction of event.amount', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'dose-a', amount: 1, time: '08:00' },
        { id: 'dose-b', amount: 2, time: '14:00' },
      ],
      dailyDose: 3,
      currentPills: 30,
    });
    const events = [
      fired({
        medicationId: 'med-1',
        doseId: 'dose-b',
        calendarDate: '2026-09-14',
        amount: 2,
        scheduledAtEpochMs: 100,
      }),
    ];
    const r = reconcileFiredEvents([med], [], events);
    expect(r.details[0].outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(28);
    expect(isExactAutoOccurrenceApplied(r.medications[0], 'dose-b', '2026-09-14')).toBe(true);
    expect(r.logs[0].amount).toBe(-2);
    expect(r.logs[0].doseId).toBe('dose-b');
  });

  it('same event twice in one batch → one deduction', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
      currentPills: 10,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'dose-a',
      calendarDate: '2026-09-14',
      amount: 1,
      scheduledAtEpochMs: 50,
    });
    const r = reconcileFiredEvents([med], [], [e, e]);
    const applied = r.details.filter((d) => d.outcome === 'applied');
    const already = r.details.filter((d) => d.outcome === 'already_applied');
    expect(applied.length).toBe(1);
    expect(already.length).toBe(1);
    expect(r.medications[0].currentPills).toBe(9);
  });

  it('marker exists + FIRED → zero additional deduction', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
      currentPills: 9,
      doseConsumptionHistory: { 'dose-a': ['2026-09-14'] },
      doseConsumption: { 'dose-a': '2026-09-14' },
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'dose-a',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('already_applied');
    expect(r.medications[0].currentPills).toBe(9);
    expect(r.mutated).toBe(false);
    expect(r.toAcknowledge).toHaveLength(1);
  });
});

describe('crash protocol model', () => {
  it('after JS persistence (marker) before native mark → restart no re-deduct', () => {
    const med = baseMed({
      doseSchedule: [{ id: 'dose-a', amount: 1, time: '08:00' }],
      currentPills: 30,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'dose-a',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    const first = reconcileFiredEvents([med], [], [e]);
    expect(first.medications[0].currentPills).toBe(29);
    // Simulate restart: event still FIRED, meds loaded with marker
    const second = reconcileFiredEvents(first.medications, first.logs, [e]);
    expect(second.details[0].outcome).toBe('already_applied');
    expect(second.medications[0].currentPills).toBe(29);
  });
});

describe('multi-dose and multi-event', () => {
  it('processes chronological and independent amounts', () => {
    const med = baseMed({
      doseSchedule: [
        { id: 'a', amount: 1, time: '08:00' },
        { id: 'b', amount: 2, time: '14:00' },
        { id: 'c', amount: 1, time: '22:00' },
      ],
      dailyDose: 4,
      currentPills: 20,
    });
    const events = [
      fired({ medicationId: 'med-1', doseId: 'c', calendarDate: '2026-09-14', amount: 1, scheduledAtEpochMs: 300 }),
      fired({ medicationId: 'med-1', doseId: 'a', calendarDate: '2026-09-14', amount: 1, scheduledAtEpochMs: 100 }),
      fired({ medicationId: 'med-1', doseId: 'b', calendarDate: '2026-09-14', amount: 2, scheduledAtEpochMs: 200 }),
    ];
    const r = reconcileFiredEvents([med], [], events);
    expect(r.details.map((d) => d.doseId)).toEqual(['a', 'b', 'c']);
    expect(r.medications[0].currentPills).toBe(16);
  });

  it('two medications stay isolated', () => {
    const m1 = baseMed({ id: 'm1', currentPills: 10, doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }] });
    const m2 = baseMed({ id: 'm2', currentPills: 10, doseSchedule: [{ id: 'd', amount: 3, time: '08:00' }] });
    const events = [
      fired({ medicationId: 'm1', doseId: 'd', calendarDate: '2026-09-14', amount: 1, scheduledAtEpochMs: 1 }),
      fired({ medicationId: 'm2', doseId: 'd', calendarDate: '2026-09-14', amount: 3, scheduledAtEpochMs: 2 }),
    ];
    const r = reconcileFiredEvents([m1, m2], [], events);
    expect(r.medications.find((m) => m.id === 'm1')!.currentPills).toBe(9);
    expect(r.medications.find((m) => m.id === 'm2')!.currentPills).toBe(7);
  });
});

describe('invalid / missing', () => {
  it('invalid amount does not change stock; acknowledges', () => {
    const med = baseMed({ currentPills: 10, doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }] });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 0 as unknown as number,
    });
    // force invalid
    (e as { amount: number }).amount = -1;
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('skipped_invalid');
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.toAcknowledge).toHaveLength(1);
  });

  it('missing medication acknowledges without crash', () => {
    const r = reconcileFiredEvents(
      [],
      [],
      [fired({ medicationId: 'gone', doseId: 'd', calendarDate: '2026-09-14', amount: 1 })]
    );
    expect(r.details[0].outcome).toBe('skipped_missing_med');
    expect(r.toAcknowledge).toHaveLength(1);
  });
});

describe('legacy', () => {
  it('legacy dailyDose identity uses LEGACY_DOSE_ID', () => {
    const med = baseMed({
      doseSchedule: undefined,
      dailyDose: 2,
      reminderTime: '08:00',
      currentPills: 20,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: LEGACY_DOSE_ID,
      calendarDate: '2026-09-14',
      amount: 2,
    });
    const r = reconcileFiredEvents([med], [], [e]);
    expect(r.details[0].outcome).toBe('applied');
    expect(r.medications[0].currentPills).toBe(18);
    expect(r.medications[0].lastConsumedDate).toBe('2026-09-14');
  });
});

describe('orchestrator persist-then-mark', () => {
  it('does not mark when persist fails', async () => {
    const med = baseMed({
      doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
      currentPills: 5,
    });
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    let marked = 0;
    const out = await runAutoDeductionReconciliation({
      medications: [med],
      logs: [],
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        marked += 1;
      },
      persistMeds: () => 'quota error',
      persistLogs: () => null,
    });
    expect(out.mutated).toBe(false);
    expect(marked).toBe(0);
    expect(out.medications[0].currentPills).toBe(5);
  });

  it('marks after successful persist; second run does not re-deduct', async () => {
    let meds = [
      baseMed({
        doseSchedule: [{ id: 'd', amount: 1, time: '08:00' }],
        currentPills: 5,
      }),
    ];
    let logs: ConsumptionLog[] = [];
    const e = fired({
      medicationId: 'med-1',
      doseId: 'd',
      calendarDate: '2026-09-14',
      amount: 1,
    });
    let marked = 0;
    const store = { meds: null as Medication[] | null };

    const first = await runAutoDeductionReconciliation({
      medications: meds,
      logs,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        marked += 1;
      },
      persistMeds: (m) => {
        store.meds = m;
        return null;
      },
      persistLogs: () => null,
    });
    expect(first.mutated).toBe(true);
    expect(first.medications[0].currentPills).toBe(4);
    expect(marked).toBe(1);

    meds = first.medications;
    logs = first.logs;
    const second = await runAutoDeductionReconciliation({
      medications: meds,
      logs,
      globalAutoDeductEnabled: true,
      listFired: async () => [e],
      markReconciled: async () => {
        marked += 1;
      },
      persistMeds: () => null,
      persistLogs: () => null,
    });
    expect(second.details[0].outcome).toBe('already_applied');
    expect(second.medications[0].currentPills).toBe(4);
    expect(marked).toBe(2); // acknowledge again is fine
  });
});

describe('disabled auto', () => {
  it('global off → no stock change, still acknowledge', () => {
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
    const r = reconcileFiredEvents([med], [], [e], { globalAutoDeductEnabled: false });
    expect(r.details[0].outcome).toBe('skipped_disabled');
    expect(r.medications[0].currentPills).toBe(10);
    expect(r.toAcknowledge).toHaveLength(1);
  });
});
