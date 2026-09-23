import type { CriticalNotificationClaim } from '../types';
import {
  claimsEqual,
  getCriticalNotificationClaim,
  loadCriticalNotificationClaims,
  saveCriticalNotificationClaims,
  setCriticalNotificationClaim,
} from './criticalNotificationClaims';

const LOCK_PREFIX = 'drugtracker-critical-notification-claim:';

type ClaimUpdater = (
  current: CriticalNotificationClaim | null
) => CriticalNotificationClaim | null;

function getLockManager(): LockManager | null {
  try {
    if (typeof navigator === 'undefined' || !navigator.locks) return null;
    return navigator.locks;
  } catch {
    return null;
  }
}

function lockName(medId: string): string {
  return LOCK_PREFIX + medId;
}

async function withClaimLock<T>(
  medId: string,
  work: () => T | Promise<T>
): Promise<T> {
  const locks = getLockManager();
  if (!locks) return work();
  return locks.request(lockName(medId), work);
}

export async function tryClaimCriticalNotification(
  medId: string,
  allowExistingScheduledClaim = false
): Promise<boolean> {
  return withClaimLock(medId, () => {
    const claims = loadCriticalNotificationClaims();
    const current = getCriticalNotificationClaim(claims, medId);
    if (current?.claimed && !(allowExistingScheduledClaim && current.alarmTime !== null)) {
      return false;
    }

    setCriticalNotificationClaim(claims, medId, {
      claimed: true,
      alarmTime: null,
    });
    return saveCriticalNotificationClaims(claims);
  });
}

export async function releaseInFlightCriticalNotificationClaim(
  medId: string
): Promise<boolean> {
  return withClaimLock(medId, () => {
    const claims = loadCriticalNotificationClaims();
    const current = getCriticalNotificationClaim(claims, medId);
    const inFlight = { claimed: true, alarmTime: null } as const;
    if (!claimsEqual(current, inFlight)) return true;

    setCriticalNotificationClaim(claims, medId, {
      claimed: false,
      alarmTime: null,
    });
    return saveCriticalNotificationClaims(claims);
  });
}

export async function updateCriticalNotificationClaim(
  medId: string,
  updater: ClaimUpdater
): Promise<{
  ok: boolean;
  updated: boolean;
  claim: CriticalNotificationClaim | null;
}> {
  return withClaimLock(medId, () => {
    const claims = loadCriticalNotificationClaims();
    const current = getCriticalNotificationClaim(claims, medId);
    const next = updater(current);

    if (next === null) {
      if (current === null) {
        return { ok: true, updated: false, claim: null };
      }
      delete claims[medId];
    } else {
      if (claimsEqual(current, next)) {
        return { ok: true, updated: false, claim: current };
      }
      setCriticalNotificationClaim(claims, medId, next);
    }

    const ok = saveCriticalNotificationClaims(claims);
    return {
      ok,
      updated: ok,
      claim: ok ? next : current,
    };
  });
}
