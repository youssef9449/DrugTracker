import type { CriticalNotificationClaim } from '../types';
import {
  claimsEqual,
  getCriticalNotificationClaim,
  readCriticalNotificationClaimsOutcome,
  saveCriticalNotificationClaims,
  setCriticalNotificationClaim,
  loadCriticalNotificationClaims,
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

export function criticalClaimLocksAvailable(): boolean {
  return getLockManager() !== null;
}

/** Lock names currently held by THIS JS context (reentrancy detection). */
const heldClaimLocks = new Set<string>();

/**
 * Lock usage mode (#484):
 * - `acquire`: an OWNERSHIP decision. The cross-document lock is REQUIRED —
 *   without it the decision is never executed unlocked; the attempt fails
 *   closed with `locks_unavailable` and the independent scheduled Critical
 *   Stock alarm remains the delivery fallback.
 * - `best_effort`: release/cleanup/cas-update operations that CANNOT create
 *   duplicate ownership. They still run (single-threaded JS semantics) when
 *   the lock primitive is missing so an episode is not permanently consumed
 *   (#484 complement of #481).
 */
type ClaimLockMode = 'acquire' | 'best_effort';

/**
 * Cross-document serialization for claim decisions. When the Web Locks API
 * is unavailable, acquisition MUST fail safe (#484): a localStorage
 * read-modify-write is NOT atomic across same-origin tabs, so unsupervised
 * acquisition could let two tabs both "win" the same notification
 * opportunity. There is no unsafe localStorage lock pretending to be
 * atomic — the caller relies on the scheduled background alarm instead.
 * Reentrant calls from the same context (e.g. a release inside an acquired
 * claim) reuse the outer lock instead of deadlocking on the same name.
 */
async function withClaimLock<T>(
  medId: string,
  mode: ClaimLockMode,
  work: () => T | Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; reason: 'locks_unavailable' }> {
  const locks = getLockManager();
  if (!locks) {
    // #484: never execute an ownership decision unlocked. Test runtimes
    // without a lock manager follow the SAME fail-closed contract — they
    // install an explicit Web Locks test double when they need to exercise
    // acquisition.
    if (mode === 'acquire') {
      return { ok: false, reason: 'locks_unavailable' };
    }
    return { ok: true, value: await work() };
  }
  const name = lockName(medId);
  if (heldClaimLocks.has(name)) {
    return { ok: true, value: await work() };
  }
  const value = await locks.request(name, async () => {
    heldClaimLocks.add(name);
    try {
      return await work();
    } finally {
      heldClaimLocks.delete(name);
    }
  });
  return { ok: true, value };
}

/**
 * Result of a coordinated critical-notification claim attempt.
 * `reason` explains a failed acquisition for diagnosability:
 * - `episode_already_claimed`: another delivery owns the episode.
 * - `locks_unavailable`: unsupported Web Locks — fail-safe skip (#484).
 * - `persist_failed`: the durable claim write did not stick.
 * - `claims_unusable`: the durable claim store could not be trusted (#485).
 */
export type ClaimAcquisitionFailureReason =
  | 'episode_already_claimed'
  | 'locks_unavailable'
  | 'persist_failed'
  | 'claims_unusable';

export type ClaimAttemptResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; reason: ClaimAcquisitionFailureReason };

/**
 * Read the current claim inside an acquired lock, distinguishing a genuinely
 * missing store from one that cannot be trusted. Corruption must never be
 * interpreted as "no claim" — that would allow duplicate notifications.
 */
function readTrustedClaim(
  medId: string
): { trusted: true; claim: CriticalNotificationClaim | null } | { trusted: false } {
  const outcome = readCriticalNotificationClaimsOutcome();
  if (outcome.status === 'invalid' || outcome.status === 'read_failed') {
    console.warn(
      `[critical-claims] claim store unusable (${outcome.status}); refusing to decide claim ownership.`
    );
    return { trusted: false };
  }
  const claims =
    outcome.status === 'ok'
      ? outcome.claims
      : loadCriticalNotificationClaims();
  return { trusted: true, claim: getCriticalNotificationClaim(claims, medId) };
}

export async function runWithCriticalNotificationClaim<T>(
  medId: string,
  allowExistingScheduledClaim: boolean,
  work: () => T | Promise<T>
): Promise<ClaimAttemptResult<T>> {
  const locked = await withClaimLock(medId, 'acquire', async () => {
    const read = readTrustedClaim(medId);
    if (!read.trusted) {
      return { acquired: false, reason: 'claims_unusable' } as ClaimAttemptResult<T>;
    }
    const current = read.claim;
    if (
      current?.claimed &&
      !(allowExistingScheduledClaim && current.alarmTime !== null)
    ) {
      return { acquired: false, reason: 'episode_already_claimed' } as ClaimAttemptResult<T>;
    }

    const claims = readCriticalNotificationClaimsOutcome();
    if (claims.status !== 'ok' && claims.status !== 'missing') {
      return { acquired: false, reason: 'claims_unusable' } as ClaimAttemptResult<T>;
    }
    const claimsMap =
      claims.status === 'ok' ? claims.claims : {};
    setCriticalNotificationClaim(claimsMap, medId, {
      claimed: true,
      alarmTime: null,
    });
    if (!saveCriticalNotificationClaims(claimsMap)) {
      return { acquired: false, reason: 'persist_failed' } as ClaimAttemptResult<T>;
    }

    try {
      return { acquired: true, result: await work() } as ClaimAttemptResult<T>;
    } catch (error) {
      // #481: an in-flight claim must never be permanently consumed by a
      // failing work() execution. Release it with the same CAS semantics as
      // the normal failure path, then propagate the original error so the
      // caller observes the real failure.
      try {
        await releaseInFlightCriticalNotificationClaim(medId);
      } catch (releaseError) {
        console.warn(
          '[critical-claims] failed to release in-flight claim after work failure:',
          releaseError
        );
      }
      throw error;
    }
  });
  if (!locked.ok) {
    return {
      acquired: false,
      reason: locked.reason === 'locks_unavailable'
        ? 'locks_unavailable'
        : 'episode_already_claimed',
    };
  }
  return locked.value;
}

export async function tryClaimCriticalNotification(
  medId: string,
  allowExistingScheduledClaim = false
): Promise<boolean> {
  const locked = await withClaimLock(medId, 'acquire', () => {
    const read = readTrustedClaim(medId);
    if (!read.trusted) return false;
    const current = read.claim;
    if (current?.claimed && !(allowExistingScheduledClaim && current.alarmTime !== null)) {
      return false;
    }

    const claimsOutcome = readCriticalNotificationClaimsOutcome();
    if (claimsOutcome.status !== 'ok' && claimsOutcome.status !== 'missing') {
      return false;
    }
    const claims = claimsOutcome.status === 'ok' ? claimsOutcome.claims : {};
    setCriticalNotificationClaim(claims, medId, {
      claimed: true,
      alarmTime: null,
    });
    return saveCriticalNotificationClaims(claims);
  });
  return locked.ok ? locked.value : false;
}

export async function releaseInFlightCriticalNotificationClaim(
  medId: string
): Promise<boolean> {
  const locked = await withClaimLock(medId, 'best_effort', () => {
    const claims = loadCriticalNotificationClaims();
    const current = getCriticalNotificationClaim(claims, medId);
    const inFlight = { claimed: true, alarmTime: null } as const;
    if (!claimsEqual(current, inFlight)) return true;

    setCriticalNotificationClaim(claims, medId, {
      claimed: false,
      alarmTime: null,
    });

    // A transient storage failure must not permanently consume the episode.
    // Retry the same CAS write a small bounded number of times without
    // yielding between attempts, so no other JS execution can interleave.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (saveCriticalNotificationClaims(claims)) return true;
    }
    return false;
  });
  // Releasing a claim cannot create a duplicate notification; when the
  // cross-document lock is unavailable the release still runs best-effort
  // (unlocked CAS with single-threaded JS semantics) so the episode is not
  // permanently consumed (#484 complement of #481). Acquisition, by
  // contrast, fails closed without locks.
  if (!locked.ok) {
    const claims = loadCriticalNotificationClaims();
    const current = getCriticalNotificationClaim(claims, medId);
    if (!claimsEqual(current, { claimed: true, alarmTime: null })) return true;
    setCriticalNotificationClaim(claims, medId, { claimed: false, alarmTime: null });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (saveCriticalNotificationClaims(claims)) return true;
    }
    return false;
  }
  return locked.value;
}

export async function updateCriticalNotificationClaim(
  medId: string,
  updater: ClaimUpdater
): Promise<{
  ok: boolean;
  updated: boolean;
  claim: CriticalNotificationClaim | null;
}> {
  const locked = await withClaimLock(medId, 'best_effort', () => {
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
  // Update/cleanup paths cannot create duplicate notifications either; run
  // the CAS update unlocked (single-threaded JS semantics) when Web Locks
  // are unsupported rather than silently dropping the update (#484).
  // Only ACQUISITION fails closed without locks.
  if (!locked.ok) {
    const claims = loadCriticalNotificationClaims();
    const current = getCriticalNotificationClaim(claims, medId);
    const next = updater(current);
    if (next === null) {
      if (current === null) return { ok: true, updated: false, claim: null };
      delete claims[medId];
    } else {
      if (claimsEqual(current, next)) {
        return { ok: true, updated: false, claim: current };
      }
      setCriticalNotificationClaim(claims, medId, next);
    }
    const ok = saveCriticalNotificationClaims(claims);
    return { ok, updated: ok, claim: ok ? next : current };
  }
  return locked.value;
}
