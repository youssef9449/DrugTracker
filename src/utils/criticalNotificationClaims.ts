/**
 * Persistent storage for per-medication critical-stock notification
 * claims — the single business source of truth for "has this
 * medication's current critical episode already claimed its ONE
 * critical-stock notification?".
 *
 * The model is deliberately tiny: { claimed: boolean, alarmTime: number | null }.
 * See CriticalNotificationClaim in types.ts for the semantics.
 *
 * Storage shape: { [medicationId]: CriticalNotificationClaim } under one
 * versioned key. All access is synchronous localStorage (via loadJson /
 * saveJson), so a read-decide-write pass is atomic with respect to other
 * JS code (single-threaded) as long as callers do not await in between.
 *
 * Migration from the previous PR state (one-way, safe, performed once
 * inside loadCriticalNotificationClaims when the v3 key is absent):
 *   - android_med_tracker_critical_transition_v2  (episode state machine)
 *   - android_med_tracker_scheduled_critical_v2   (scheduled-claim records)
 *   - android_med_tracker_critical_ownership_v2   (ownership revisions)
 * An ongoing episode whose notification was already consumed
 * (SCHEDULED / FIRED_OR_DUE / SENT) migrates to claimed=true so
 * upgrading users do not get a duplicate notification. An episode that
 * had NOT yet consumed its notification (NONE) migrates to claimed=false
 * so its remaining opportunity is preserved. A scheduled record that was
 * armed for a future crossing without an episode carries over as
 * claimed=true with its alarm time.
 */

import type { CriticalNotificationClaim } from '../types';
import { loadJson, saveJson } from './storage';

export const CRITICAL_CLAIMS_STORAGE_KEY = 'android_med_tracker_critical_claims_v3';

/** Deprecated migration sources (previous PR state). Removed after migration. */
const LEGACY_TRANSITION_V2_KEY = 'android_med_tracker_critical_transition_v2';
const LEGACY_SCHEDULED_V2_KEY = 'android_med_tracker_scheduled_critical_v2';
const LEGACY_OWNERSHIP_V2_KEY = 'android_med_tracker_critical_ownership_v2';

function isValidClaimsMap(value: unknown): value is Record<string, CriticalNotificationClaim> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as CriticalNotificationClaim).claimed === 'boolean' &&
      ((entry as CriticalNotificationClaim).alarmTime === null ||
        typeof (entry as CriticalNotificationClaim).alarmTime === 'number')
  );
}

function removeLegacyKeys(): void {
  try {
    localStorage.removeItem(LEGACY_TRANSITION_V2_KEY);
    localStorage.removeItem(LEGACY_SCHEDULED_V2_KEY);
    localStorage.removeItem(LEGACY_OWNERSHIP_V2_KEY);
  } catch {
    // best-effort hygiene
  }
}

/**
 * Migrate the previous state-machine stores into the simple claim map.
 * Pure function over the parsed legacy values.
 */
export function migrateLegacyClaims(
  legacyTransitions: unknown,
  legacyScheduled: unknown
): Record<string, CriticalNotificationClaim> {
  const claims: Record<string, CriticalNotificationClaim> = {};

  const transitions =
    legacyTransitions && typeof legacyTransitions === 'object' && !Array.isArray(legacyTransitions)
      ? (legacyTransitions as Record<string, { notificationState?: unknown }>)
      : {};
  const scheduled =
    legacyScheduled && typeof legacyScheduled === 'object' && !Array.isArray(legacyScheduled)
      ? (legacyScheduled as Record<string, { alarmTime?: unknown; status?: unknown }>)
      : {};

  const ids = new Set([...Object.keys(transitions), ...Object.keys(scheduled)]);
  for (const medId of ids) {
    const transitionState = transitions[medId]?.notificationState;
    const record = scheduled[medId];
    const recordScheduled =
      !!record &&
      (record.status === 'SCHEDULED' ||
        // Records written before statuses existed: a positive alarmTime
        // meant the alarm was successfully registered.
        (record.status === undefined && typeof record.alarmTime === 'number' && record.alarmTime > 0));

    if (transitionState === undefined || transitionState === 'NONE') {
      // The episode had not consumed its notification opportunity yet —
      // preserve it. If a future alarm was armed for the (upcoming)
      // crossing, carry the claim with its alarm time; otherwise the
      // opportunity stays open with no claim.
      if (recordScheduled && typeof record?.alarmTime === 'number' && record.alarmTime > 0) {
        claims[medId] = { claimed: true, alarmTime: record.alarmTime };
      } else {
        claims[medId] = { claimed: false, alarmTime: null };
      }
      continue;
    }

    // SCHEDULED / FIRED_OR_DUE / SENT — the episode's notification
    // opportunity was consumed. claimed=true, no delivery reconstruction.
    claims[medId] = { claimed: true, alarmTime: null };
  }
  return claims;
}

/**
 * Load the persistent claim map, running the one-time legacy migration
 * when the v3 key is absent. Never throws; corrupt data is discarded
 * (which can only ever re-open a notification opportunity — never
 * duplicate one for a consumed episode... and a re-opened opportunity
 * after corruption is acceptable: the alternative, guessing "claimed",
 * could permanently silence a real episode).
 */
export function loadCriticalNotificationClaims(): Record<string, CriticalNotificationClaim> {
  const stored = loadJson<unknown>(CRITICAL_CLAIMS_STORAGE_KEY, null);
  if (stored !== null) {
    return isValidClaimsMap(stored) ? stored : {};
  }

  // One-time migration from the previous state-machine stores.
  const legacyTransitions = loadJson<unknown>(LEGACY_TRANSITION_V2_KEY, null);
  const legacyScheduled = loadJson<unknown>(LEGACY_SCHEDULED_V2_KEY, null);
  if (legacyTransitions === null && legacyScheduled === null) {
    return {};
  }
  const claims = migrateLegacyClaims(legacyTransitions, legacyScheduled);
  saveJson(CRITICAL_CLAIMS_STORAGE_KEY, claims);
  removeLegacyKeys();
  return claims;
}

/** Persist the claim map. */
export function saveCriticalNotificationClaims(claims: Record<string, CriticalNotificationClaim>): void {
  saveJson(CRITICAL_CLAIMS_STORAGE_KEY, claims);
}

/** Read one medication's claim from a loaded map (null when absent). */
export function getCriticalNotificationClaim(
  claims: Record<string, CriticalNotificationClaim>,
  medId: string
): CriticalNotificationClaim | null {
  return claims[medId] ?? null;
}

/** Convenience: read one medication's claim straight from storage. */
export function readCriticalNotificationClaim(medId: string): CriticalNotificationClaim | null {
  return getCriticalNotificationClaim(loadCriticalNotificationClaims(), medId);
}

/** Write one medication's claim into a loaded map (caller persists). */
export function setCriticalNotificationClaim(
  claims: Record<string, CriticalNotificationClaim>,
  medId: string,
  claim: CriticalNotificationClaim
): void {
  claims[medId] = claim;
}

/** Remove one medication's claim entry from a loaded map (caller persists). */
export function clearCriticalNotificationClaim(
  claims: Record<string, CriticalNotificationClaim>,
  medId: string
): void {
  delete claims[medId];
}

/** True when two claims are exactly equal (used as a tiny CAS check). */
export function claimsEqual(
  a: CriticalNotificationClaim | null,
  b: CriticalNotificationClaim | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.claimed === b.claimed && a.alarmTime === b.alarmTime;
}

// ─────────────────────────────────────────────────────────────────────
// Per-medication operation queue for NATIVE alarm bridge calls.
//
// cancelCriticalAlarm() and scheduleCriticalAlarm() are async (Capacitor
// bridge) and share one stable native notification id per medication.
// Free-running interleaves could let an older operation's cancel remove
// a newer operation's freshly-armed alarm (or vice versa). Chaining all
// native critical-alarm operations per medication serializes them, so
// each operation observes the effects of the previous one.
//
// This is plain in-memory async hygiene — no persisted scheduler
// ownership state. Callers add their own generation/status checks
// around their operations (see useCriticalAlarmScheduler).
// ─────────────────────────────────────────────────────────────────────

const alarmChains = new Map<string, Promise<void>>();

/**
 * Append an async native-alarm operation to the per-medication chain.
 * The operation runs only after every previously-enqueued operation for
 * this medication has settled.
 */
export function enqueueCriticalAlarmOp(medId: string, op: () => Promise<void>): Promise<void> {
  const prev = alarmChains.get(medId) ?? Promise.resolve();
  const next = prev.then(op, op); // run whether prev resolved or rejected
  alarmChains.set(medId, next);
  // Swallow the stored tail's rejection so it never surfaces as an
  // unhandled rejection; ops catch their own errors.
  next.catch(() => undefined);
  return next;
}
