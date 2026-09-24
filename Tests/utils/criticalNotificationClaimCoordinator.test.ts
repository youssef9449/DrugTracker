import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCriticalNotificationClaims } from '@/utils/criticalNotificationClaims';
import {
  runWithCriticalNotificationClaim,
  releaseInFlightCriticalNotificationClaim,
  tryClaimCriticalNotification,
  updateCriticalNotificationClaim,
} from '@/utils/criticalNotificationClaimCoordinator';
import {
  installWebLocksShim,
  removeWebLocks,
  type WebLocksShimHandle,
} from '../helpers/webLocksShim';

/**
 * #484: claim ACQUISITION is an ownership decision and requires the
 * cross-document Web Lock. These tests install an explicit Web Locks test
 * double for the serialization scenarios and separately prove the
 * fail-closed contract when no lock manager exists.
 */

let locks: WebLocksShimHandle | null = null;

function withLocks(): WebLocksShimHandle {
  locks = installWebLocksShim();
  return locks;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  removeWebLocks();
  locks = null;
});

afterEach(() => {
  locks?.uninstall();
  locks = null;
});

describe('critical notification claim coordinator (with Web Locks)', () => {
  it('allows only one same-medication claim when two callers race', async () => {
    withLocks();
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
    withLocks();
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
    withLocks();
    await tryClaimCriticalNotification('med-1');
    await updateCriticalNotificationClaim('med-1', () => ({
      claimed: true,
      alarmTime: Date.now() + 60_000,
    }));

    await expect(
      releaseInFlightCriticalNotificationClaim('med-1')
    ).resolves.toBe(true);

    expect(loadCriticalNotificationClaims()['med-1']?.alarmTime).toBeGreaterThan(Date.now());
  });

  it('holds cross-tab ownership until foreground delivery work resolves', async () => {
    withLocks();
    let releaseWork!: () => void;
    const work = new Promise<boolean>((resolve) => {
      releaseWork = () => resolve(true);
    });

    const first = runWithCriticalNotificationClaim(
      'med-lock',
      true,
      () => work
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(tryClaimCriticalNotification('med-lock')).resolves.toBe(false);

    releaseWork();
    await expect(first).resolves.toMatchObject({
      acquired: true,
      result: true,
    });
  });

  it('keeps ownership on failed delivery until the caller explicitly releases it', async () => {
    withLocks();
    await expect(
      runWithCriticalNotificationClaim('med-fail', false, async () => false)
    ).resolves.toMatchObject({ acquired: true, result: false });

    expect(loadCriticalNotificationClaims()['med-fail']).toEqual({
      claimed: true,
      alarmTime: null,
    });
  });
});

describe('#484 fail-closed acquisition without Web Locks', () => {
  it('two unsupported-lock contexts can NOT both acquire the same notification opportunity', async () => {
    // No lock manager installed — both contexts attempt acquisition.
    const [a, b] = await Promise.all([
      tryClaimCriticalNotification('med-nolocks'),
      tryClaimCriticalNotification('med-nolocks'),
    ]);

    // Neither may acquire, and no ownership may be written unlocked.
    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(loadCriticalNotificationClaims()['med-nolocks']).toBeUndefined();
    expect(Object.keys(loadCriticalNotificationClaims())).toHaveLength(0);
  });

  it('runWithCriticalNotificationClaim reports locks_unavailable and never executes work unlocked', async () => {
    let workRan = false;
    const result = await runWithCriticalNotificationClaim(
      'med-nolocks-rw',
      false,
      () => {
        workRan = true;
        return 'delivered' as const;
      }
    );

    expect(result).toEqual({ acquired: false, reason: 'locks_unavailable' });
    expect(workRan).toBe(false);
    expect(loadCriticalNotificationClaims()['med-nolocks-rw']).toBeUndefined();
  });

  it('release/cleanup remains best-effort without locks (episode not consumed)', async () => {
    // Seed an in-flight claim as if a previous context had acquired it.
    localStorage.setItem(
      'android_med_tracker_critical_claims_v3',
      JSON.stringify({ 'med-release': { claimed: true, alarmTime: null } })
    );

    await expect(
      releaseInFlightCriticalNotificationClaim('med-release')
    ).resolves.toBe(true);
    expect(loadCriticalNotificationClaims()['med-release']).toEqual({
      claimed: false,
      alarmTime: null,
    });
  });
});
