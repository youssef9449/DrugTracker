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
 *
 * Migration precedence (evaluated per medication, FIRST match wins):
 *   1. SENT / FIRED_OR_DUE
 *      → claimed=true, alarmTime=null
 *      because the notification opportunity is already consumed.
 *      Any scheduled record beside these states is stale legacy residue
 *      and must not resurrect a second notification.
 *   2. Otherwise, a valid FUTURE scheduled alarm
 *      → claimed=true, alarmTime=<future alarm time>
 *      because the alarm is still the active notification opportunity.
 *   3. Otherwise, an elapsed scheduled alarm
 *      → claimed=true, alarmTime=null
 *      because delivery is not reconstructed and we must avoid
 *      duplicates (never pretend an elapsed alarm is still future).
 *   4. Otherwise, NONE / no consumed opportunity
 *      → claimed=false, alarmTime=null.
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
 *
 * Migration precedence (FIRST match wins — SENT/FIRED_OR_DUE beat a
 * future scheduled record, which is stale residue beside them):
 *   1. SENT / FIRED_OR_DUE      → consumed (claimed=true, alarmTime=null).
 *   2. Valid FUTURE armed alarm → preserved with its alarmTime.
 *   3. Elapsed armed alarm      → consumed (claimed=true, alarmTime=null).
 *   4. NONE / no transition, nothing armed → open (claimed=false,
 *      alarmTime=null).
 *   5. SCHEDULED without any armed record → consumed.
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

  const now = Date.now();
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
    const armedAlarmTime =
      recordScheduled && typeof record?.alarmTime === 'number' ? record.alarmTime : null;
    // A successfully armed alarm whose fire time is still ahead of us.
    // It must survive migration WITH its time: nulling it would make the
    // new scheduler treat the claim as mismatched, cancel/re-arm the
    // live alarm, and a failed re-arm would lose the future notification
    // while the medication is still Sufficient.
    const hasFutureAlarm = armedAlarmTime !== null && armedAlarmTime > now;

    if (transitionState === 'SENT' || transitionState === 'FIRED_OR_DUE') {
      // The notification was already delivered by a foreground send
      // (SENT) or a fired/due native alarm (FIRED_OR_DUE). A still-armed
      // record alongside these states is stale legacy residue — never
      // resurrect it for an already-sent notification.
      claims[medId] = { claimed: true, alarmTime: null };
      continue;
    }

    if (hasFutureAlarm) {
      // A valid FUTURE scheduled alarm takes precedence over the
      // transition state (SCHEDULED / NONE / none): preserve it exactly
      // as armed.
      claims[medId] = { claimed: true, alarmTime: armedAlarmTime };
      continue;
    }

    if (transitionState === undefined || transitionState === 'NONE') {
      if (armedAlarmTime !== null) {
        // Elapsed armed alarm: the new architecture deliberately does
        // not reconstruct Android delivery state, so it migrates as a
        // consumed opportunity — this prevents a duplicate foreground
        // notification right after the upgrade.
        claims[medId] = { claimed: true, alarmTime: null };
      } else {
        // The episode had not consumed its notification opportunity —
        // it stays open.
        claims[medId] = { claimed: false, alarmTime: null };
      }
      continue;
    }

    // SCHEDULED with an elapsed or absent scheduled record: consumed,
    // no delivery reconstruction.
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
