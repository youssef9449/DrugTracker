import { describe, expect, it } from 'vitest';
import type { CriticalNotificationClaim, Medication } from '@/types';
import {
  evaluateCriticalStockPolicy,
  type CriticalStockPolicyDecision,
} from '@/utils/criticalStockPolicy';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'dose-1', amount: 1, time: '20:00' }],
    ...overrides,
  };
}

const NOW = new Date('2024-09-10T12:00:00Z').getTime();
const TODAY = '2024-09-10';

function decide(
  medication: Medication,
  claim: CriticalNotificationClaim | null = null,
  criticalStockAlertsEnabled = true
): CriticalStockPolicyDecision {
  return evaluateCriticalStockPolicy({
    medication,
    claim,
    criticalStockAlertsEnabled,
    todayStr: TODAY,
    nowMs: NOW,
  });
}

describe('evaluateCriticalStockPolicy', () => {
  it('uses one foreground decision for an active critical episode', () => {
    const decision = decide(makeMed({ currentPills: 0 }));

    expect(decision.isCriticalEpisode).toBe(true);
    expect(decision.canNotify).toBe(true);
    expect(decision.desiredDelivery).toBe('foreground');
    expect(decision.foregroundEligible).toBe(true);
    expect(decision.scheduledDeliveryDesired).toBe(false);
    expect(decision.shouldClearClaim).toBe(false);
  });

  it('keeps notifications disabled without consuming a critical episode', () => {
    const decision = decide(
      makeMed({ currentPills: 0 }),
      { claimed: false, alarmTime: null },
      false
    );

    expect(decision.isCriticalEpisode).toBe(true);
    expect(decision.canNotify).toBe(false);
    expect(decision.desiredDelivery).toBe('none');
    expect(decision.foregroundEligible).toBe(false);
    expect(decision.scheduledDeliveryDesired).toBe(false);
    expect(decision.shouldClearClaim).toBe(false);
  });

  it('chooses scheduled delivery for sufficient stock with a future crossing', () => {
    const decision = decide(makeMed({ currentPills: 30 }));

    expect(decision.isCriticalEpisode).toBe(false);
    expect(decision.criticalDateMs).not.toBeNull();
    expect(decision.desiredDelivery).toBe('scheduled');
    expect(decision.scheduledDeliveryDesired).toBe(true);
    expect(decision.foregroundEligible).toBe(false);
    expect(decision.claimState).toBe('absent');
  });

  it('blocks scheduled delivery while foreground owns an in-flight claim', () => {
    const decision = decide(makeMed({ currentPills: 30 }), {
      claimed: true,
      alarmTime: null,
    });

    expect(decision.scheduledDeliveryDesired).toBe(true);
    expect(decision.scheduledDeliveryBlockedByForeground).toBe(true);
    expect(decision.desiredDelivery).toBe('scheduled');
  });

  it('allows foreground delivery when a future scheduled claim exists for an active episode', () => {
    const scheduledAt = NOW + 60 * 60 * 1000;
    const decision = decide(makeMed({ currentPills: 0 }), {
      claimed: true,
      alarmTime: scheduledAt,
    });

    expect(decision.foregroundEligible).toBe(true);
    expect(decision.desiredDelivery).toBe('foreground');
    expect(decision.shouldClearClaim).toBe(false);
  });

  it('recognizes only the exact future projection as the current scheduled claim', () => {
    const base = decide(makeMed({ currentPills: 30 }));
    expect(base.criticalDateMs).not.toBeNull();

    const matching = decide(makeMed({ currentPills: 30 }), {
      claimed: true,
      alarmTime: base.criticalDateMs,
    });
    const stale = decide(makeMed({ currentPills: 31 }), {
      claimed: true,
      alarmTime: base.criticalDateMs,
    });

    expect(matching.claimState).toBe('scheduled-current');
    expect(matching.matchingScheduledClaim).toBe(true);
    expect(matching.shouldClearClaim).toBe(false);
    expect(stale.matchingScheduledClaim).toBe(false);
    expect(stale.shouldClearClaim).toBe(true);
  });

  it('does not clear claims while the critical episode is active', () => {
    const decision = decide(makeMed({ currentPills: 0 }), {
      claimed: true,
      alarmTime: NOW - 1,
    });

    expect(decision.isCriticalEpisode).toBe(true);
    expect(decision.claimState).toBe('foreground-consumed');
    expect(decision.shouldClearClaim).toBe(false);
    expect(decision.foregroundEligible).toBe(false);
  });

  it('clears stale claims when stock returns to sufficient without a live matching alarm', () => {
    const decision = decide(makeMed({ currentPills: 20 }), {
      claimed: true,
      alarmTime: NOW - 1,
    });

    expect(decision.isCriticalEpisode).toBe(false);
    expect(decision.shouldClearClaim).toBe(true);
  });

  it('does not project a crossing when Auto Deduction is off', () => {
    const decision = decide(makeMed({ autoDeductEnabled: false }));

    expect(decision.criticalDateMs).toBeNull();
    expect(decision.scheduledDeliveryDesired).toBe(false);
    expect(decision.desiredDelivery).toBe('none');
  });

  it('preserves multi-dose crossing semantics through the shared policy', () => {
    const decision = decide(
      makeMed({
        currentPills: 11,
        dailyDose: 3,
        warningThresholdDays: 3,
        doseSchedule: [
          { id: 'morning', amount: 1, time: '08:00' },
          { id: 'evening', amount: 2, time: '20:00' },
        ],
      })
    );

    expect(decision.daysLeft).toBe(3);
    expect(decision.isCriticalEpisode).toBe(true);
    expect(decision.desiredDelivery).toBe('foreground');
  });
});
