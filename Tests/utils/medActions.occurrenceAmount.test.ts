import { describe, it, expect } from 'vitest';
import { findActiveDeductionForOccurrence } from '@/utils/medActions';
import type { ConsumptionLog } from '@/types';
import { exactAutoLogId } from '@/utils/autoDeductionReconciliation';

/**
 * Phase 4 UI / restore amount authority:
 * persisted occurrence log amount is authoritative per medicationId+doseId+date.
 */
describe('findActiveDeductionForOccurrence — sibling isolation + historical amount', () => {
  const today = '2026-09-14';

  it('Manual d2 restore must not pick Auto d1 amount (sibling isolation)', () => {
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med', 'd1', today),
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd1',
        amount: -2,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: today,
      },
      {
        id: 'log-d2-manual',
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd2',
        amount: -1,
        type: 'dose_taken',
        timestamp: '2026-09-14T09:00:00.000Z',
        date: today,
      },
    ];
    const d1 = findActiveDeductionForOccurrence(logs, 'med', 'd1', today);
    const d2 = findActiveDeductionForOccurrence(logs, 'med', 'd2', today);
    // exact_auto evidence is only recognized with the deterministic
    // occurrence id (exact-auto:<med>:<dose>:<date>) — which is the id the
    // log above carries.
    expect(d1?.id).toBe(exactAutoLogId('med', 'd1', today));
    expect(Math.abs(Number(d1?.amount))).toBe(2);
    expect(d2?.id).toBe('log-d2-manual');
    expect(Math.abs(Number(d2?.amount))).toBe(1);
  });

  it('Auto historical amount survives schedule amount change', () => {
    // FIRED / exact_auto stored amount=2 even if current schedule slot is 1
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med', 'd1', today),
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd1',
        amount: -2,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: today,
      },
    ];
    const active = findActiveDeductionForOccurrence(logs, 'med', 'd1', today);
    expect(active).not.toBeNull();
    expect(Math.abs(Number(active!.amount))).toBe(2);
    // UI must use log amount, not current schedule amount (1)
    const currentScheduleAmount = 1;
    const uiAmount = Math.abs(Number(active!.amount));
    expect(uiAmount).toBe(2);
    expect(uiAmount).not.toBe(currentScheduleAmount);
  });

  it('exact occurrence identity does not cross-pick sibling dose events', () => {
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med', 'd2', today),
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd2',
        amount: -5,
        type: 'exact_auto',
        timestamp: '2026-09-14T10:00:00.000Z',
        date: today,
      },
    ];
    expect(findActiveDeductionForOccurrence(logs, 'med', 'd1', today)).toBeNull();
    expect(
      findActiveDeductionForOccurrence(logs, 'med', 'd2', today)?.amount
    ).toBe(-5);
  });

  it('when persisted exact deduction exists, do not fall back to schedule defaults', () => {
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med', 'd1', today),
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd1',
        amount: -3,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: today,
      },
    ];
    const active = findActiveDeductionForOccurrence(logs, 'med', 'd1', today);
    const historical =
      active && Number.isFinite(Number(active.amount))
        ? Math.abs(Number(active.amount))
        : 0;
    // doseSchedule[0]=1, dailyDose=9 must not replace historical when log exists
    const scheduleFallback = 1;
    const dailyFallback = 9;
    const amount =
      historical > 0 ? historical : scheduleFallback || dailyFallback || 1;
    expect(amount).toBe(3);
  });

  it('missing doseId returns null (no legacy matching — #267)', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'legacy-log',
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        amount: -2,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: today,
      },
    ];
    const active = findActiveDeductionForOccurrence(
      logs,
      'med',
      '',
      today
    );
    expect(active).toBeNull();
  });

  it('d1 log cannot restore d2 (doseId isolation — #267)', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'd1-log',
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd1',
        amount: -2,
        type: 'dose_taken',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: today,
      },
    ];
    const active = findActiveDeductionForOccurrence(
      logs,
      'med',
      'd2',
      today
    );
    expect(active).toBeNull();
  });

  it('whitespace-only doseId returns null (no occurrence match — #267)', () => {
    const logs: ConsumptionLog[] = [
      {
        id: 'd1-log',
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd1',
        amount: -2,
        type: 'dose_taken',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: today,
      },
    ];
    expect(findActiveDeductionForOccurrence(logs, 'med', '   ', today)).toBeNull();
    expect(findActiveDeductionForOccurrence(logs, 'med', '', today)).toBeNull();
  });

  it('padded doseId normalizes and matches log doseId', () => {
    const logs: ConsumptionLog[] = [
      {
        id: exactAutoLogId('med', 'd1', today),
        medicationId: 'med',
        medicationName: 'Test Medication',
        description: 'Test dose',
        doseId: 'd1',
        amount: -2,
        type: 'exact_auto',
        timestamp: '2026-09-14T08:00:00.000Z',
        date: today,
      },
    ];
    const active = findActiveDeductionForOccurrence(logs, 'med', ' d1 ', today);
    expect(active?.id).toBe(exactAutoLogId('med', 'd1', today));
    expect(active?.amount).toBe(-2);
  });
});
