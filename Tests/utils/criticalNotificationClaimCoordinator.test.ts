import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadCriticalNotificationClaims,
  saveCriticalNotificationClaims,
} from '@/utils/criticalNotificationClaims';
import {
  releaseInFlightCriticalNotificationClaim,
  tryClaimCriticalNotification,
  updateCriticalNotificationClaim,
} from '@/utils/criticalNotificationClaimCoordinator';

describe('critical notification claim coordinator', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('allows only one same-medication claim when two callers race', async () => {
    const [first, second] = await Promise.all([
      tryClaimCriticalNotification('med-race'),
      tryClaimCriticalNotification('med-race'),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(loadCriticalNotificationClaims()['med-race']).toEqual({
      claimed: true,
      alarmTime: null,
    });
  });

  it('allows a foreground claim to replace a future scheduled claim atomically', async () => {
    expect(
      await updateCriticalNotificationClaim('med-1', () => ({
        claimed: true,
        alarmTime: Date.now() + 60_000,
      }))
    ).toMatchObject({ ok: true, updated: true });

    await expect(
      tryClaimCriticalNotification('med-1', true)
    ).resolves.toBe(true);

    expect(loadCriticalNotificationClaims()['med-1']).toEqual({
      claimed: true,
      alarmTime: null,
    });
  });

  it('does not release a newer scheduled claim after a failed foreground delivery', async () => {
    await tryClaimCriticalNotification('med-1');
    await updateCriticalNotificationClaim('med-1', () => ({
      claimed: true,
      alarmTime: Date.now() + 60_000,
    }));

    await expect(
      releaseInFlightCriticalNotificationClaim('med-1')
    ).resolves.toBe(true);

    expect(saveCriticalNotificationClaims(loadCriticalNotificationClaims())).toBe(true);
    expect(loadCriticalNotificationClaims()['med-1']?.alarmTime).toBeGreaterThan(Date.now());
  });
});
