/**
 * Authoritative persistent state for critical-stock episodes.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   1. Critical transition identity (one per continuous critical episode).
 *   2. Scheduled critical-alarm records (pure scheduling data, separate).
 *   3. The per-medication OWNERSHIP REVISION (see below).
 *   4. The one authoritative episode reconcile algorithm shared by
 *      useStockAlerts (episode owner) and consumed indirectly by
 *      useCriticalAlarmScheduler (which NEVER creates identities).
 *
 * == Core invariants enforced here ==
 * - One continuous critical episode (sufficient → critical → … →
 *   sufficient) maps to exactly ONE transitionKey. The key is generated
 *   ONCE at episode start, persisted immediately, and reused everywhere.
 * - The transitionKey NEVER depends on criticalDateMs / alarmTime /
 *   currentPills / effectiveCurrentPills / lastSyncDate / dailyDose /
 *   warningThresholdDays / today / the crossing date. Those are mutable
 *   scheduling or snapshot data — not identity.
 * - Critical → OutOfStock keeps the same transition (same key, no second
 *   notification). Critical → Sufficient ENDS the episode (record deleted
 *   + its scheduled claim cleared). A later Sufficient → Critical begins
 *   a NEW episode with a NEW key.
 * - `alarmTime <= Date.now()` is NEVER treated as proof that the native
 *   notification was displayed. SCHEDULED ≠ DELIVERED. Delivery is only
 *   recorded from positive native evidence (see applyDeliveredCriticalEvidence)
 *   or from migrated state that already carried evidence.
 * - A scheduled claim whose firing window has passed (alarmTime <= now)
 *   is CONSUMED for that transition: the transition moves to
 *   notificationState 'FIRED_OR_DUE' and the record to status
 *   'FIRED_OR_DUE'. FIRED_OR_DUE is TERMINAL for the episode's
 *   notification ownership: delivery is UNKNOWN (the alarm may have
 *   fired while the app was dead and been dismissed, or never fired),
 *   so the claim must NEVER be re-armed for the same transition, and
 *   the foreground path must NOT send on top of it. Only positive
 *   native evidence upgrades FIRED_OR_DUE → SENT.
 * - An episode whose notificationState is SENT can never regain a
 *   SCHEDULED claim (canScheduleForTransition refuses; the helpers
 *   enforce it — see updateScheduledAlarm). The same protection covers
 *   FIRED_OR_DUE episodes and consumed (FIRED_OR_DUE / DELIVERED)
 *   claims still bound to the active transition.
 * - Scheduled-record writes are funneled through the ownership helpers
 *   below: the episode owner binds (bindScheduledAlarmToTransition) and
 *   invalidates ownership (invalidateEpisodeOwnership), the scheduler
 *   only updates scheduling data (updateScheduledAlarm /
 *   invalidateScheduledAlarm / clearScheduledAlarm) with generation
 *   checks so a stale scheduler operation can never clobber the record
 *   written by a newer one, erase a binding to the active episode, or
 *   resurrect a binding to a dead one.
 *
 * == Ownership revision (episode-vs-scheduler race safety) ==
 * The record `generation` only answers "is this scheduler write newer
 * than another SCHEDULER write?" — episode-owner lifecycle writes
 * (bind / episode end / notificationState change) intentionally do not
 * bump it. To close that gap, a per-medication monotonic
 * `ownershipRevision` is persisted alongside the two state stores and
 * bumped by EVERY episode-owner lifecycle change: episode created,
 * episode ended (sufficient or med deleted), notification ownership
 * changed (NONE → SCHEDULED / → SENT), owner bind, and positive
 * delivery evidence. A scheduler operation captures the full ownership
 * context (captureSchedulingContext) BEFORE its async native work and
 * must verify it (isSchedulingContextStillValid) BEFORE writing
 * persistent scheduled state — otherwise the operation is stale and
 * must abandon the write (and cancel the native alarm it armed).
 *
 * == Storage versioning / migration ==
 *   v2 (current): android_med_tracker_critical_transition_v2
 *                 android_med_tracker_scheduled_critical_v2
 *                 android_med_tracker_critical_ownership_v2
 *   Legacy (read-once migration sources, then removed):
 *     - android_med_tracker_critical_transition_v1
 *     - android_med_tracker_critical_notified_v2
 *     - android_med_tracker_scheduled_critical_v1
 *
 *   The FIRED_OR_DUE claim state does NOT bump the storage version: the
 *   persisted SHAPE (fields) of all three stores is unchanged, only the
 *   value domain of two enum fields grew, and both directions normalize
 *   safely (older code reading 'FIRED_OR_DUE' falls back to the safe
 *   "already handled" direction; this code accepts it explicitly).
 *   There is exactly ONE authoritative representation after migration —
 *   no legacy key participates in the state machine.
 *
 * All storage access is synchronous (localStorage via loadJson/saveJson),
 * so reconcile passes are atomic with respect to each other and either
 * hook effect order produces a consistent state (no render-order races).
 */

import {
  CriticalNotificationState,
  CriticalTransitionState,
  ScheduledCriticalAlarmRecord,
  ScheduledCriticalAlarmStatus,
} from '../types';
import { loadJson, saveJson, loadString } from './storage';

export const CRITICAL_TRANSITION_STORAGE_KEY = 'android_med_tracker_critical_transition_v2';
export const SCHEDULED_CRITICAL_STORAGE_KEY = 'android_med_tracker_scheduled_critical_v2';

/** Deprecated — migration source only. Removed once v2 exists. */
export const LEGACY_TRANSITION_V1_KEY = 'android_med_tracker_critical_transition_v1';
/** Deprecated — migration source only. Removed once v2 exists. */
export const LEGACY_CRITICAL_NOTIFIED_KEY = 'android_med_tracker_critical_notified_v2';
/** Deprecated — migration source only. Removed once v2 exists. */
export const LEGACY_SCHEDULED_V1_KEY = 'android_med_tracker_scheduled_critical_v1';

// ─────────────────────────────────────────────────────────────────────
// Key generation
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate an opaque, unique identity for a NEW critical episode.
 *
 * The timestamp and random suffix exist ONLY to make collisions
 * practically impossible (two episodes of the same med within the same
 * millisecond, device clock jumps, etc.). The key is never parsed,
 * never compared structurally, and never derived from any medication
 * snapshot or projected alarm date.
 *
 * MUST only be called by the episode owner (reconcileCriticalEpisode)
 * at the moment an episode actually begins.
 */
export function generateCriticalTransitionKey(medId: string, timestamp: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `crit_${medId}_${timestamp}_${rand}`;
}

// ─────────────────────────────────────────────────────────────────────
// Transition store (episode identity) — v2 with legacy migration
// ─────────────────────────────────────────────────────────────────────

function isValidTransitionMap(value: unknown): value is Record<string, CriticalTransitionState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return true;
}

/** Coerce a raw persisted entry into a valid CriticalTransitionState, or null. */
function normalizeTransitionEntry(raw: unknown): CriticalTransitionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Partial<CriticalTransitionState> & { notificationSent?: unknown };
  const transitionKey = typeof rec.transitionKey === 'string' && rec.transitionKey ? rec.transitionKey : null;
  if (!transitionKey) return null;
  const enteredAt = typeof rec.enteredAt === 'number' && Number.isFinite(rec.enteredAt) ? rec.enteredAt : 0;
  // v2 shape uses notificationState; v1 shape used the boolean notificationSent.
  let notificationState: CriticalNotificationState;
  if (
    rec.notificationState === 'SCHEDULED' ||
    rec.notificationState === 'SENT' ||
    rec.notificationState === 'NONE' ||
    rec.notificationState === 'FIRED_OR_DUE'
  ) {
    notificationState = rec.notificationState;
  } else if (rec.notificationSent === true) {
    notificationState = 'SENT';
  } else if (rec.notificationSent === false) {
    notificationState = 'NONE';
  } else {
    // Unknown shape — the safe direction is "already handled" (no duplicate).
    notificationState = 'SENT';
  }
  return { transitionKey, enteredAt, notificationState };
}

function removeLegacyCriticalState(): void {
  try {
    localStorage.removeItem(LEGACY_TRANSITION_V1_KEY);
    localStorage.removeItem(LEGACY_CRITICAL_NOTIFIED_KEY);
  } catch {
    // ignore — removal is best-effort hygiene
  }
}

/**
 * Load the persistent critical transition map: { [medId]: CriticalTransitionState }.
 *
 * Migration (explicit, safe, one-way):
 *   1. v2 store present → return it verbatim (lazy-remove legacy keys).
 *   2. v1 transition store present → convert to v2
 *      (notificationSent true → 'SENT', false → 'NONE') and persist v2.
 *      These were genuinely active episodes, so preserving their
 *      notificationSent flag preserves the no-duplicate guarantee.
 *   3. Legacy notified map (android_med_tracker_critical_notified_v2)
 *      present → convert each entry to { transitionKey, enteredAt: 0,
 *      notificationState: 'SENT' }. enteredAt is 0 (NOT Date.now()) so
 *      migrated metadata is never misleading — 0 means "unknown, legacy".
 *      The legacy map's meaning ("this med's current episode was already
 *      notified") justifies carrying it forward as a SENT transition so
 *      upgrading users do not get one extra duplicate notification.
 *   4. Nothing → empty map.
 */
export function loadCriticalTransitions(): Record<string, CriticalTransitionState> {
  const v2 = loadJson<unknown>(CRITICAL_TRANSITION_STORAGE_KEY, null);
  if (v2 !== null) {
    if (isValidTransitionMap(v2)) {
      // Lazy hygiene: v2 is authoritative → deprecated keys can go.
      if (loadString(LEGACY_TRANSITION_V1_KEY, '') !== '' || loadString(LEGACY_CRITICAL_NOTIFIED_KEY, '') !== '') {
        removeLegacyCriticalState();
      }
      return v2;
    }
    // Corrupt v2 → fall through to migration sources rather than crashing.
  }

  // Migration source 1: v1 transition map.
  const v1 = loadJson<unknown>(LEGACY_TRANSITION_V1_KEY, null);
  if (v1 !== null && isValidTransitionMap(v1)) {
    const migrated: Record<string, CriticalTransitionState> = {};
    for (const [id, raw] of Object.entries(v1)) {
      const entry = normalizeTransitionEntry(raw);
      if (entry) migrated[id] = entry;
    }
    saveJson(CRITICAL_TRANSITION_STORAGE_KEY, migrated);
    removeLegacyCriticalState();
    return migrated;
  }

  // Migration source 2: legacy notified map ({ [medId]: transitionKey }).
  const legacy = loadJson<unknown>(LEGACY_CRITICAL_NOTIFIED_KEY, null);
  if (legacy !== null && isValidTransitionMap(legacy)) {
    const migrated: Record<string, CriticalTransitionState> = {};
    for (const [id, key] of Object.entries(legacy)) {
      if (typeof key === 'string' && key) {
        migrated[id] = { transitionKey: key, enteredAt: 0, notificationState: 'SENT' };
      }
    }
    saveJson(CRITICAL_TRANSITION_STORAGE_KEY, migrated);
    removeLegacyCriticalState();
    return migrated;
  }

  return {};
}

/**
 * Save the persistent critical transition map (v2 only — no legacy mirrors).
 */
export function saveCriticalTransitions(transitions: Record<string, CriticalTransitionState>): void {
  saveJson(CRITICAL_TRANSITION_STORAGE_KEY, transitions);
}

// ─────────────────────────────────────────────────────────────────────
// Scheduled alarm store — v2 with legacy migration
// ─────────────────────────────────────────────────────────────────────

function normalizeScheduledStatus(raw: unknown, alarmTime: number): ScheduledCriticalAlarmStatus {
  if (
    raw === 'SCHEDULED' ||
    raw === 'FIRED_OR_DUE' ||
    raw === 'DELIVERED' ||
    raw === 'NOT_SCHEDULED'
  ) {
    return raw;
  }
  // Legacy records without a status: a positive alarmTime meant a
  // successfully-registered alarm. Keep that (it was the registration
  // outcome, not a delivery claim).
  return alarmTime > 0 ? 'SCHEDULED' : 'NOT_SCHEDULED';
}

function normalizeScheduledRecord(raw: unknown): ScheduledCriticalAlarmRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as { transitionKey?: unknown; alarmTime?: unknown; status?: unknown; generation?: unknown };
  const alarmTime = typeof rec.alarmTime === 'number' && Number.isFinite(rec.alarmTime) ? rec.alarmTime : 0;
  const normalized: ScheduledCriticalAlarmRecord = {
    transitionKey: typeof rec.transitionKey === 'string' ? rec.transitionKey : '',
    alarmTime,
    status: normalizeScheduledStatus(rec.status, alarmTime),
  };
  // generation is optional: only preserve a well-formed revision counter,
  // otherwise the field stays absent (treated as 0 by the write helpers).
  if (typeof rec.generation === 'number' && Number.isFinite(rec.generation) && rec.generation >= 0) {
    normalized.generation = rec.generation;
  }
  return normalized;
}

/**
 * Load the persistent scheduled critical alarm records:
 * { [medId]: ScheduledCriticalAlarmRecord }.
 *
 * Every entry (v2 or migrated) is normalized defensively so callers
 * never see malformed records. Migration from v1 keeps the record's
 * alarmTime + status and its transitionKey if present. Legacy keys were
 * derived from projected dates (the old, broken scheme) but they are
 * only ever honored as opaque adoptable claims — no new identity is
 * ever derived from them.
 */
export function loadScheduledCriticalAlarms(): Record<string, ScheduledCriticalAlarmRecord> {
  const v2 = loadJson<unknown>(SCHEDULED_CRITICAL_STORAGE_KEY, null);
  if (v2 !== null && typeof v2 === 'object' && !Array.isArray(v2)) {
    const normalized: Record<string, ScheduledCriticalAlarmRecord> = {};
    for (const [id, raw] of Object.entries(v2 as Record<string, unknown>)) {
      const rec = normalizeScheduledRecord(raw);
      if (rec) normalized[id] = rec;
    }
    return normalized;
  }

  const v1 = loadJson<unknown>(LEGACY_SCHEDULED_V1_KEY, null);
  if (v1 !== null && typeof v1 === 'object' && !Array.isArray(v1)) {
    const migrated: Record<string, ScheduledCriticalAlarmRecord> = {};
    for (const [id, raw] of Object.entries(v1 as Record<string, unknown>)) {
      const rec = normalizeScheduledRecord(raw);
      if (rec) migrated[id] = rec;
    }
    saveJson(SCHEDULED_CRITICAL_STORAGE_KEY, migrated);
    try {
      localStorage.removeItem(LEGACY_SCHEDULED_V1_KEY);
    } catch {
      // ignore
    }
    return migrated;
  }

  return {};
}

/**
 * Save the persistent scheduled critical alarm records (v2 only).
 */
export function saveScheduledCriticalAlarms(records: Record<string, ScheduledCriticalAlarmRecord>): void {
  saveJson(SCHEDULED_CRITICAL_STORAGE_KEY, records);
}

// ─────────────────────────────────────────────────────────────────────
// Ownership-revision store — episode-vs-scheduler race safety
//
// A per-medication monotonic counter that the EPISODE OWNER bumps on
// every lifecycle change that invalidates in-flight scheduler work:
//   - a critical episode is created
//   - a critical episode ends (med became sufficient / transition
//     removed / medication deleted)
//   - the notification ownership state changes
//     (NONE → SCHEDULED / NONE → SENT / SCHEDULED → SENT)
//   - the owner binds a scheduled record to an episode
//
// The scheduled record's `generation` does NOT cover these changes (it
// is a scheduler-vs-scheduler revision only), so a scheduler operation
// that captured only the generation could happily write after an
// episode ended and resurrect its dead scheduled claim. The ownership
// revision closes that hole: scheduler operations capture it in their
// ownership context (captureSchedulingContext) and abandon their write
// when it moved on (isSchedulingContextStillValid).
//
// Missing entries mean 0. Entries are never deleted (they are tiny
// numbers); bumping on medication deletion is what invalidates
// in-flight scheduler operations for that medication.
// ─────────────────────────────────────────────────────────────────────

export const CRITICAL_OWNERSHIP_STORAGE_KEY = 'android_med_tracker_critical_ownership_v2';

export function loadOwnershipRevisions(): Record<string, number> {
  const raw = loadJson<unknown>(CRITICAL_OWNERSHIP_STORAGE_KEY, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const revisions: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      revisions[id] = value;
    }
  }
  return revisions;
}

export function saveOwnershipRevisions(revisions: Record<string, number>): void {
  saveJson(CRITICAL_OWNERSHIP_STORAGE_KEY, revisions);
}

/** Current ownership revision for a medication (0 when never bumped). */
export function getOwnershipRevision(revisions: Record<string, number>, medId: string): number {
  return revisions[medId] ?? 0;
}

/**
 * EPISODE OWNER ONLY (and the scheduler's deleted-medication cleanup):
 * bump the medication's ownership revision so every in-flight scheduler
 * operation that captured its context before this point becomes stale.
 * Returns true when the map changed (caller persists).
 */
export function bumpEpisodeOwnershipRevision(
  revisions: Record<string, number>,
  medId: string
): boolean {
  const next = (revisions[medId] ?? 0) + 1;
  if (revisions[medId] === next) return false;
  revisions[medId] = next;
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Scheduled-record ownership / versioning helpers
//
// These helpers ENCODE the write invariants so callers cannot
// accidentally violate them (e.g. erasing a valid episode binding with
// `records[id] = { transitionKey: '', … }`).
//
// Two writers exist, with strictly separated powers:
//
//   THE EPISODE OWNER (useStockAlerts via reconcileCriticalEpisode)
//     - creates/deletes episode identity
//     - binds an existing scheduled record to an episode
//       (bindScheduledAlarmToTransition) and invalidates its own
//       episode's claim at episode end (invalidateEpisodeOwnership)
//     - bumps the ownership revision on every lifecycle change
//     - writes synchronously; needs no generation check (it IS
//       authoritative)
//
//   THE SCHEDULER (useCriticalAlarmScheduler)
//     - may READ the active identity (getActiveTransition) but NEVER
//       generate, adopt, or delete one
//     - writes scheduling data only, through updateScheduledAlarm /
//       invalidateScheduledAlarm / clearScheduledAlarm, which enforce:
//         * generation check — an operation captures the record's
//           generation BEFORE its async native work and may persist
//           only if the stored generation is unchanged (a stale
//           generation must abandon the write)
//         * ownership-context check — the operation must also verify
//           its captured SchedulingOwnershipContext (ownership
//           revision + active episode identity + notification state)
//           before writing; the helpers below refuse writes that would
//           create a SCHEDULED claim for a SENT episode or resurrect a
//           dead one
//         * binding rule — a successfully scheduled claim is bound to
//           the CURRENTLY ACTIVE transition (if any), never to a dead
//           one and never blindly unbound when an episode is active
// ─────────────────────────────────────────────────────────────────────

/**
 * READ the authoritative active transition for a medication, if one
 * exists. This is the ONLY identity-related access the scheduler is
 * allowed: read-only. It must never create, adopt, mutate, or delete a
 * transition.
 */
export function getActiveTransition(
  transitions: Record<string, CriticalTransitionState>,
  medId: string
): CriticalTransitionState | null {
  return transitions[medId] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Scheduled-claim phase classification
//
// A SCHEDULED record's alarmTime splits the claim's lifecycle into
// phases with DIFFERENT rules. Elapsed time alone proves nothing about
// delivery — it only means the firing window has been reached:
//
//   PENDING_FUTURE  — the native alarm is still pending (reliable
//                     evidence it has not fired yet). The claim may be
//                     updated/rescheduled (cancel + new alarm) while it
//                     stays future.
//   DUE_OR_PAST     — the firing window has been reached. Delivery is
//                     UNKNOWN (fired-while-dead-then-dismissed, or never
//                     fired). The claim MUST be consumed by the episode
//                     owner (consumeDueScheduledClaim) and must NEVER
//                     be re-armed for the same transition.
//   CONSUMED_WINDOW — the owner already consumed the claim
//                     (status FIRED_OR_DUE). Terminal for this
//                     transition: no re-arm, no foreground send.
//   DELIVERED       — positive delivery evidence was recorded. Terminal;
//                     upgrades the episode to SENT.
//   INVALID / NO_CLAIM — no valid claim exists.
// ─────────────────────────────────────────────────────────────────────

export type ScheduledClaimPhase =
  | 'NO_CLAIM'
  | 'PENDING_FUTURE'
  | 'DUE_OR_PAST'
  | 'CONSUMED_WINDOW'
  | 'DELIVERED'
  | 'INVALID';

/**
 * Classify the current phase of a medication's scheduled claim.
 * Pure function — no I/O, no clock reads other than the passed `now`.
 */
export function getScheduledClaimPhase(
  rec: ScheduledCriticalAlarmRecord | undefined,
  now: number
): ScheduledClaimPhase {
  if (!rec) return 'NO_CLAIM';
  switch (rec.status) {
    case 'SCHEDULED':
      return rec.alarmTime > now ? 'PENDING_FUTURE' : 'DUE_OR_PAST';
    case 'FIRED_OR_DUE':
      return 'CONSUMED_WINDOW';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'NOT_SCHEDULED':
    default:
      return 'INVALID';
  }
}

/**
 * Reliable evidence that the native alarm is still pending: the claim
 * is SCHEDULED and its fire time is in the future. Only a PENDING_FUTURE
 * claim may be rescheduled/updated; a due/past claim must never be
 * re-armed for the same transition.
 */
export function isScheduledClaimFuture(
  rec: ScheduledCriticalAlarmRecord | undefined,
  now: number
): boolean {
  return getScheduledClaimPhase(rec, now) === 'PENDING_FUTURE';
}

/**
 * The claim's firing window has been reached (SCHEDULED + alarmTime <=
 * now). Delivery is UNKNOWN — this is NOT evidence of delivery and NOT
 * evidence of non-delivery. The claim must be consumed, not re-armed.
 */
export function isScheduledClaimDue(
  rec: ScheduledCriticalAlarmRecord | undefined,
  now: number
): boolean {
  return getScheduledClaimPhase(rec, now) === 'DUE_OR_PAST';
}

// ─────────────────────────────────────────────────────────────────────
// Scheduler ownership context (episode-vs-scheduler race safety)
//
// A scheduler operation spans async native bridge calls (cancel +
// schedule). The persistent ownership state can change UNDER it: the
// episode owner may end the episode, begin a new one, change the
// notification ownership, or delete the medication. The record's
// `generation` does not move for any of those (it is scheduler-write
// revision only), so an operation that checked only the generation
// could resurrect a dead claim or restore notification ownership after
// it was consumed.
//
// The rule: capture the immutable ownership context BEFORE any async
// work and verify it is STILL valid after the native work resolves.
// Only then may the operation write persistent scheduled state.
// ─────────────────────────────────────────────────────────────────────

/**
 * Immutable ownership context captured by a scheduler operation BEFORE
 * its async native work. Every field must still match at write time
 * (isSchedulingContextStillValid) or the operation is stale.
 */
export interface SchedulingOwnershipContext {
  medId: string;
  /** Active episode identity at capture ('' when no episode was active). */
  baselineTransitionKey: string;
  /**
   * Notification ownership state of the active episode at capture
   * (null when no episode was active). A NONE → SENT flip under the
   * operation invalidates it even when the revision store is missing.
   */
  baselineNotificationState: CriticalNotificationState | null;
  /** Per-med ownership revision at capture (0 when never bumped). */
  baselineOwnershipRevision: number;
  /** Scheduled-record generation at capture (0 when no record existed). */
  baselineRecordGeneration: number;
  /** The record's binding at capture ('' when unbound or absent). */
  baselineRecordTransitionKey: string;
}

/**
 * Capture the scheduling ownership context for a medication from the
 * CURRENT authoritative stores. Must be called before the operation's
 * first await (before any native bridge work).
 *
 * Pure function over the passed maps — callers load the maps fresh
 * (loadCriticalTransitions / loadScheduledCriticalAlarms /
 * loadOwnershipRevisions) at capture time.
 */
export function captureSchedulingContext(
  transitions: Record<string, CriticalTransitionState>,
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  ownershipRevisions: Record<string, number>,
  medId: string
): SchedulingOwnershipContext {
  const active = transitions[medId];
  const record = scheduled[medId];
  return {
    medId,
    baselineTransitionKey: active?.transitionKey ?? '',
    baselineNotificationState: active ? active.notificationState : null,
    baselineOwnershipRevision: ownershipRevisions[medId] ?? 0,
    baselineRecordGeneration: record?.generation ?? 0,
    baselineRecordTransitionKey: record?.transitionKey ?? '',
  };
}

/**
 * Verify that a scheduling operation's captured ownership context is
 * still valid against the CURRENT authoritative stores. Every captured
 * field is compared; ANY mismatch means an episode-owner lifecycle
 * change (or a newer scheduler write) happened under the operation and
 * it MUST NOT write persistent scheduled state.
 */
export function isSchedulingContextStillValid(
  context: SchedulingOwnershipContext,
  transitions: Record<string, CriticalTransitionState>,
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  ownershipRevisions: Record<string, number>
): boolean {
  const active = transitions[context.medId];
  const record = scheduled[context.medId];
  return (
    // Episode-owner lifecycle change (create / end / state change /
    // bind / deletion) — the authoritative invalidation signal.
    (ownershipRevisions[context.medId] ?? 0) === context.baselineOwnershipRevision &&
    // Same episode still active (key never changes within an episode).
    (active?.transitionKey ?? '') === context.baselineTransitionKey &&
    // Notification ownership did not flip under the operation
    // (e.g. the foreground sent while the operation awaited).
    (active ? active.notificationState : null) === context.baselineNotificationState &&
    // No newer scheduler write replaced the record.
    (record?.generation ?? 0) === context.baselineRecordGeneration &&
    // The record's binding did not move (owner bind/adopt).
    (record?.transitionKey ?? '') === context.baselineRecordTransitionKey
  );
}

/**
 * Whether a successfully-registered native alarm may currently own a
 * notification claim for this medication's active episode.
 *
 * Rules:
 * - an episode whose single notification was already SENT must never
 *   regain a SCHEDULED claim — that would restore notification
 *   ownership after it was consumed and arm a second user-facing
 *   notification for the same episode;
 * - an episode whose owning claim reached its firing window
 *   (FIRED_OR_DUE) is equally terminal: the alarm opportunity was
 *   consumed (delivery unknown) and must never be re-created;
 * - episodes in the NONE or SCHEDULED state (and meds with no active
 *   episode) may receive a scheduled claim.
 */
export function canScheduleForTransition(
  transitions: Record<string, CriticalTransitionState>,
  medId: string
): boolean {
  const active = getActiveTransition(transitions, medId);
  if (!active) return true;
  return active.notificationState !== 'SENT' && active.notificationState !== 'FIRED_OR_DUE';
}

/**
 * EPISODE OWNER ONLY: bind an existing scheduled record to the given
 * episode identity. This overwrites any previous binding (an unbound
 * claim becomes bound; a stale binding from a previous episode is
 * replaced — the owner is authoritative). It does NOT touch status,
 * alarmTime, or generation.
 *
 * Returns true when the map changed (caller persists).
 */
export function bindScheduledAlarmToTransition(
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  medId: string,
  transitionKey: string
): boolean {
  const rec = scheduled[medId];
  if (!rec || !transitionKey || rec.transitionKey === transitionKey) return false;
  rec.transitionKey = transitionKey;
  return true;
}

/**
 * EPISODE OWNER ONLY: invalidate the scheduler ownership of an episode
 * that just ENDED (med became sufficient, or the episode's transition
 * was removed for any other reason).
 *
 * 1. Neutralizes the scheduled claim that was bound to the dead
 *    transition (status → NOT_SCHEDULED) so it can never suppress,
 *    adopt into, or be resurrected for a FUTURE episode.
 * 2. Bumps the ownership revision so EVERY in-flight scheduler
 *    operation that captured its context before this point becomes
 *    stale — a late native scheduling result can no longer write a
 *    SCHEDULED claim for the dead episode.
 *
 * Returns true when any store map changed (caller persists).
 */
export function invalidateEpisodeOwnership(
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  ownershipRevisions: Record<string, number>,
  medId: string,
  deadTransitionKey: string
): boolean {
  let changed = false;
  const rec = scheduled[medId];
  if (rec && rec.transitionKey === deadTransitionKey && rec.status !== 'NOT_SCHEDULED') {
    rec.status = 'NOT_SCHEDULED';
    changed = true;
  }
  if (bumpEpisodeOwnershipRevision(ownershipRevisions, medId)) {
    changed = true;
  }
  return changed;
}

/** Input for {@link updateScheduledAlarm}. */
export interface ScheduledAlarmUpdate {
  alarmTime: number;
  /**
   * The record generation the scheduling operation observed BEFORE its
   * async native work (baseline). If the stored record's generation no
   * longer matches, a newer scheduler write happened in between and
   * this stale operation MUST abandon the storage write.
   */
  baselineGeneration: number;
  /**
   * The operation's view of "now" (epoch ms), used to classify the
   * EXISTING claim's phase (still pending vs firing window reached).
   * Defaults to Date.now() when omitted.
   */
  now?: number;
}

/** Outcome of {@link updateScheduledAlarm}. */
export type ScheduledAlarmWriteResult = 'persisted' | 'unchanged' | 'refused';

/**
 * SCHEDULER ONLY: persist the outcome of a SUCCESSFUL native schedule
 * (the alarm is armed at `update.alarmTime`).
 *
 * Ownership rules enforced here (the heart of the ownership model):
 *
 *   Notification-ownership rule — if the ACTIVE episode's notification
 *   was already consumed (SENT, or FIRED_OR_DUE: the owning claim's
 *   firing window passed), the write is REFUSED entirely (returns
 *   'refused', no mutation). A consumed episode must never regain a
 *   SCHEDULED claim: that would restore notification ownership after
 *   it was spent and arm a second user-facing notification for the
 *   same episode. The scheduler is responsible for cancelling the
 *   native alarm it armed in that case (see canScheduleForTransition
 *   for the pre-arm relevance check).
 *
 *   Consumed-claim rule — a claim still bound to the ACTIVE transition
 *   whose notification opportunity is spent must NEVER be re-armed as
 *   SCHEDULED for the same transition: this covers the terminal
 *   FIRED_OR_DUE / DELIVERED statuses AND a SCHEDULED claim whose
 *   firing window has already been reached (alarmTime <= now). That
 *   last case is exactly the "alarm fired while the app was dead, user
 *   dismissed it, app reopens, scheduler re-arms" duplicate. Only a
 *   still-future pending claim may be rescheduled, and only a claim
 *   bound to a dead/absent episode may be overwritten by a genuinely
 *   new opportunity (new episode or no episode yet).
 *
 *   Binding rule — transitionKey := the ACTIVE transition's key for
 *   this med, or '' when no episode is currently active:
 *     - a record already bound to the active episode KEEPS that binding
 *       (the alarm time can change; the episode identity cannot);
 *     - a stale binding to a dead episode is dropped, never resurrected;
 *     - an unbound claim stays unbound when no episode is active;
 *     - when an episode IS active, the claim becomes its bound claim.
 *
 * The scheduler never generates an identity here — it only reads the
 * authoritative transition map passed by the caller.
 *
 * Generation rule: the write is ABANDONED (returns 'refused', no
 * mutation) when the stored record's generation differs from the
 * operation's baseline — i.e. another scheduler write landed while this
 * operation was awaiting the native bridge. Accepted writes bump
 * generation.
 *
 * NOTE: the generation check alone does NOT make an operation safe to
 * write — episode-owner lifecycle changes do not bump the generation.
 * Callers must additionally verify their captured ownership context
 * (isSchedulingContextStillValid) before invoking this helper. The
 * helper still enforces the invariants below as the last line of
 * defense so a future caller cannot bypass the state machine.
 *
 * Returns:
 *   'persisted' — the record was written (caller must persist the map);
 *   'unchanged' — the record already held exactly this scheduling data
 *                 (the re-armed alarm matches the claim — keep it);
 *   'refused'   — the write was refused by an ownership/consumption
 *                 rule; the caller MUST cancel the native alarm it
 *                 armed (an alarm without a valid claim may never
 *                 survive).
 */
export function updateScheduledAlarm(
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  transitions: Record<string, CriticalTransitionState>,
  medId: string,
  update: ScheduledAlarmUpdate
): ScheduledAlarmWriteResult {
  const existing = scheduled[medId];
  // Stale-generation protection: only the write whose baseline still
  // matches the stored record may proceed.
  if (existing && (existing.generation ?? 0) !== update.baselineGeneration) {
    return 'refused';
  }
  // Notification-ownership rule: never create a SCHEDULED claim for an
  // episode whose single notification was already consumed (SENT) or
  // whose owning claim's window passed (FIRED_OR_DUE) — SENT →
  // SCHEDULED and FIRED_OR_DUE → SCHEDULED are both forbidden for the
  // same transitionKey.
  if (!canScheduleForTransition(transitions, medId)) {
    return 'refused';
  }
  // READ (never create) the authoritative episode identity.
  const activeKey = getActiveTransition(transitions, medId)?.transitionKey ?? '';
  // Consumed-claim rule: a claim still bound to the ACTIVE transition
  // whose opportunity is spent (consumed statuses, or a SCHEDULED claim
  // whose firing window was reached) is terminal for that transition.
  if (
    existing &&
    existing.transitionKey !== '' &&
    existing.transitionKey === activeKey &&
    (existing.status === 'FIRED_OR_DUE' ||
      existing.status === 'DELIVERED' ||
      isScheduledClaimDue(existing, update.now ?? Date.now()))
  ) {
    return 'refused';
  }
  const next: ScheduledCriticalAlarmRecord = {
    // Preserve the active episode's binding; drop dead/stale bindings.
    transitionKey: activeKey,
    alarmTime: update.alarmTime,
    status: 'SCHEDULED',
    generation: (existing?.generation ?? 0) + 1,
  };
  if (
    existing &&
    existing.transitionKey === next.transitionKey &&
    existing.alarmTime === next.alarmTime &&
    existing.status === next.status
  ) {
    // Scheduling data unchanged — nothing to persist, no revision.
    return 'unchanged';
  }
  scheduled[medId] = next;
  return 'persisted';
}

/**
 * SCHEDULER ONLY: neutralize the med's scheduled claim after a native
 * cancel or a failed schedule — status → NOT_SCHEDULED so no valid
 * SCHEDULED claim survives (the foreground notification path stays
 * available in the episode owner). The transitionKey is PRESERVED:
 * binding information is not the scheduler's to erase; the owner
 * rebinding or episode-end logic decides what a neutralized record
 * means later.
 *
 * Stale-generation safe (same rule as {@link updateScheduledAlarm})
 * when a baselineGeneration is provided.
 *
 * Returns true when the map changed (caller persists).
 */
export function invalidateScheduledAlarm(
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  medId: string,
  baselineGeneration?: number
): boolean {
  const rec = scheduled[medId];
  if (!rec || rec.status === 'NOT_SCHEDULED') return false;
  if (baselineGeneration !== undefined && (rec.generation ?? 0) !== baselineGeneration) {
    return false;
  }
  rec.status = 'NOT_SCHEDULED';
  if (baselineGeneration !== undefined) {
    rec.generation = (rec.generation ?? 0) + 1;
  }
  return true;
}

/**
 * SCHEDULER ONLY: remove the med's scheduled record entirely (the
 * medication was deleted; the owner deletes the transition separately).
 * Stale-generation safe like the other helpers.
 *
 * Returns true when the map changed (caller persists).
 */
export function clearScheduledAlarm(
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  medId: string,
  baselineGeneration?: number
): boolean {
  const rec = scheduled[medId];
  if (!rec) return false;
  if (baselineGeneration !== undefined && (rec.generation ?? 0) !== baselineGeneration) {
    return false;
  }
  delete scheduled[medId];
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// The ONE authoritative episode reconcile algorithm
// ─────────────────────────────────────────────────────────────────────

/** Per-call dirty flags the caller persists when set. */
export interface ReconcileDirtyFlags {
  transitions: boolean;
  scheduled: boolean;
  /** The ownership-revision store changed (caller persists it). */
  ownership: boolean;
}

export interface ReconcileMedInput {
  medId: string;
  /** true when calculateMedicationStatus says 'critical' or 'out_of_stock'. */
  isCriticalish: boolean;
  /** notificationsEnabled && criticalStockAlertsEnabled. */
  canNotify: boolean;
  now: number;
  /** Side effect that shows the foreground critical notification.
   *  Invoked at most once per episode, only from the NONE state. */
  send: () => void;
}

export interface ReconcileEpisodeResult {
  transition: CriticalTransitionState;
  created: boolean;
  notificationSent: boolean;
}

/**
 * Reconcile ONE medication's critical-episode state against the three
 * persistent stores (mutated in place; caller persists when dirty).
 *
 * This is the ONLY place a transition is created or a foreground
 * notification decision is made. The scheduler consumes the resulting
 * records and never generates identities, so React effect order between
 * the two hooks cannot produce contradictory state (requirement: either
 * order is safe).
 *
 * Episode lifecycle implemented here:
 *
 *   SUFFICIENT ──crossing──► CRITICAL EPISODE A (key generated once)
 *       ▲                          │  critical / out_of_stock /
 *       │                          │  auto deduction / manual consume /
 *       │                          │  refill-while-critical / restart /
 *       │                          │  reschedule … SAME key, ≤1 notification
 *       └──── episode ends ────────┘
 *             (transition deleted + bound scheduled claim neutralized
 *              + ownership revision bumped — in-flight scheduler
 *              operations from the dead episode become stale)
 *
 * Notification ownership:
 *   Path A (foreground): NONE ──send──► SENT. A claim bound to the
 *   episode is neutralized at the same moment (the foreground consumed
 *   the episode's single notification opportunity; an alarm still
 *   armed for it is stale and is cancelled by the scheduler — and can
 *   never resurrect the claim because the state says no claim exists).
 *   Path B (scheduled):  a validly-registered alarm owns the episode's
 *   single notification → the foreground stays quiet. A failed
 *   scheduling attempt (status NOT_SCHEDULED) is NOT a valid claim →
 *   the foreground path remains available.
 *
 *   Once the owning claim's firing window has been reached
 *   (alarmTime <= now), the claim is CONSUMED: the transition moves to
 *   'FIRED_OR_DUE' and the record to status 'FIRED_OR_DUE'. Delivery is
 *   UNKNOWN at that point (fired-while-dead-then-dismissed, or never
 *   fired) — so FIRED_OR_DUE is terminal for this transition: no
 *   re-arm, no foreground send. Only positive native evidence (drawer
 *   presence) upgrades it to 'SENT'.
 *
 * Adoption is restricted to UNBOUND claims (transitionKey ''): bound
 * claims belong to the episode they were bound to, and by the time a
 * creation pass runs, that episode is gone — adopting a bound claim
 * would resurrect a dead episode's identity. An adopted claim whose
 * window already passed yields a 'FIRED_OR_DUE' episode (NOT a
 * SCHEDULED one — elapsed time is not delivery); an adopted claim with
 * recorded delivery evidence (status DELIVERED) yields 'SENT'. Only
 * every ownership mutation here bumps the medication's ownership
 * revision, which invalidates any in-flight scheduler operation
 * captured earlier.
 */
export function reconcileCriticalEpisode(
  transitions: Record<string, CriticalTransitionState>,
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  ownershipRevisions: Record<string, number>,
  input: ReconcileMedInput,
  dirty: ReconcileDirtyFlags
): ReconcileEpisodeResult | null {
  const { medId, isCriticalish, canNotify, now, send } = input;
  const rec = scheduled[medId];

  // ── Episode end: critical/out_of_stock → sufficient ──
  if (!isCriticalish) {
    const t = transitions[medId];
    if (t) {
      // Kill the episode's bound scheduled claim so a stale record can
      // never adopt/suppress a FUTURE episode (new key, new claim),
      // and bump the ownership revision so any in-flight scheduler
      // operation from this dead episode can no longer write a
      // scheduled claim for it.
      if (
        invalidateEpisodeOwnership(scheduled, ownershipRevisions, medId, t.transitionKey)
      ) {
        dirty.scheduled = true;
        dirty.ownership = true;
      }
      delete transitions[medId];
      dirty.transitions = true;
    }
    return null;
  }

  // ── Episode present or beginning ──
  let created = false;
  let t = transitions[medId];

  if (!t) {
    // No persisted transition. Two valid creation paths:
    //
    // (a) ADOPT a pending UNBOUND scheduled claim: an alarm was
    //     successfully registered for this med while it was still
    //     sufficient (claims are only written unbound when no episode
    //     is active) and its (projected) fire time has passed — the
    //     crossing most likely happened while the app was dead and the
    //     native alarm was displayed. The claim becomes the episode
    //     identity and keeps notification ownership. Because the
    //     firing window has ALREADY passed at adoption time, the
    //     adopted episode is 'FIRED_OR_DUE' (delivery UNKNOWN) — never
    //     'SCHEDULED': elapsed time is not delivery, and the consumed
    //     opportunity must never be re-armed for this transition. If
    //     the record already carries delivery evidence (status
    //     DELIVERED), the episode is 'SENT' immediately.
    // (b) FRESH episode: crossing detected in the foreground (or no
    //     valid claim exists — including failed scheduling). The key is
    //     generated ONCE here and persisted immediately.
    //     A BOUND claim is never adopted: binding means it belonged to
    //     an episode that has since ended (a crash between the owner's
    //     two store writes is the only way to observe that state) — a
    //     new episode must never inherit a dead episode's identity.
    const claim = rec && rec.transitionKey === '' ? getScheduledClaimPhase(rec, now) : null;
    const adoptableClaim =
      claim === 'DUE_OR_PAST' || claim === 'CONSUMED_WINDOW' || claim === 'DELIVERED';

    if (rec && adoptableClaim) {
      const key = rec.transitionKey || generateCriticalTransitionKey(medId, now);
      t = {
        transitionKey: key,
        enteredAt: rec.alarmTime > 0 ? rec.alarmTime : now,
        notificationState: claim === 'DELIVERED' ? 'SENT' : 'FIRED_OR_DUE',
      };
      // Owner bind: the adopted claim carries this episode's identity.
      if (bindScheduledAlarmToTransition(scheduled, medId, key)) {
        dirty.scheduled = true;
      }
      // Consume the adopted claim whose window already passed: the
      // episode owns whatever notification that alarm produced (or
      // didn't). It can never be re-armed for this transition.
      if (rec.status === 'SCHEDULED') {
        rec.status = 'FIRED_OR_DUE';
        dirty.scheduled = true;
      }
    } else {
      t = {
        transitionKey: generateCriticalTransitionKey(medId, now),
        enteredAt: now,
        notificationState: 'NONE',
      };
      if (rec) {
        if (rec.transitionKey === '') {
          // Bind a still-pending (future) alarm to this episode so it can
          // never be mistaken for another episode's claim later. A FUTURE
          // alarm does not suppress the foreground — the crossing already
          // happened earlier than projected, and the scheduler cancels the
          // stale alarm right after (same React commit).
          if (bindScheduledAlarmToTransition(scheduled, medId, t.transitionKey)) {
            dirty.scheduled = true;
          }
        } else {
          // A claim still bound to ANOTHER key at creation time is a
          // leftover of a DEAD episode (a crash between the owner's two
          // store writes is the only way to observe that state) — in any
          // status (SCHEDULED / FIRED_OR_DUE / DELIVERED). Neutralize it:
          // a dead episode's claim must never be inherited by — or own,
          // suppress, or be resurrected for — a new episode.
          rec.status = 'NOT_SCHEDULED';
          dirty.scheduled = true;
        }
      }
    }
    transitions[medId] = t;
    dirty.transitions = true;
    created = true;
    // New episode → new ownership context: invalidate every in-flight
    // scheduler operation captured before this point.
    if (bumpEpisodeOwnershipRevision(ownershipRevisions, medId)) {
      dirty.ownership = true;
    }
  }

  // ── Consume due/past bound claims (FIRED_OR_DUE terminality) ──
  // Any claim bound to the active episode whose firing window has been
  // reached (or that is already recorded as consumed/delivered) fixes
  // the episode's notification ownership here: SCHEDULED/NONE →
  // FIRED_OR_DUE (or DELIVERED evidence → SENT below). After this pass
  // the foreground can never send on top of a consumed claim, and the
  // claim can never be re-armed (the record is terminal too).
  consumeDueScheduledClaim(transitions, scheduled, ownershipRevisions, medId, now, dirty);

  // Migrated/recorded delivery evidence on the bound claim upgrades a
  // SCHEDULED or FIRED_OR_DUE episode to SENT without any async work.
  if (
    (t.notificationState === 'SCHEDULED' || t.notificationState === 'FIRED_OR_DUE') &&
    rec &&
    rec.transitionKey === t.transitionKey &&
    rec.status === 'DELIVERED'
  ) {
    t.notificationState = 'SENT';
    dirty.transitions = true;
    if (bumpEpisodeOwnershipRevision(ownershipRevisions, medId)) {
      dirty.ownership = true;
    }
  }

  // ── Foreground notification decision (Path A) ──
  let notificationSent = false;
  if (t.notificationState === 'NONE') {
    // Reached only when no valid scheduled claim owns this episode
    // (ownership upgrades/consumption above have already consumed that
    // case). A failed scheduling attempt (NOT_SCHEDULED) and a
    // still-future claim both leave the foreground path available.
    if (canNotify) {
      send();
      // Mark optimistically BEFORE the async send resolves: the send
      // helper never rejects (errors are caught internally), and marking
      // first guarantees at-most-once even if the app dies mid-send.
      t.notificationState = 'SENT';
      dirty.transitions = true;
      notificationSent = true;
      // The foreground just consumed the episode's single notification
      // opportunity — neutralize its bound claim (if any) so no valid
      // SCHEDULED claim survives for a SENT episode. Any native alarm
      // still armed for that claim is stale; the scheduler cancels it
      // (and can never re-arm it: the claim no longer exists).
      if (
        rec &&
        rec.transitionKey === t.transitionKey &&
        rec.status === 'SCHEDULED'
      ) {
        rec.status = 'NOT_SCHEDULED';
        dirty.scheduled = true;
      }
      // Ownership consumed → invalidate in-flight scheduler operations:
      // a late scheduling result must never re-arm a notification for
      // this episode (SENT can never become SCHEDULED again).
      if (bumpEpisodeOwnershipRevision(ownershipRevisions, medId)) {
        dirty.ownership = true;
      }
    }
    // canNotify false → state stays 'NONE'. Disabling alerts must NOT
    // consume the episode: re-enabling while still critical allows
    // exactly one notification.
  }

  return { transition: t, created, notificationSent };
}

/**
 * EPISODE OWNER ONLY (called from reconcileCriticalEpisode): consume a
 * scheduled claim bound to the ACTIVE transition once its firing window
 * has been reached, or repair an already-consumed claim whose episode
 * state lags behind (e.g. a crash between the owner's two store
 * writes).
 *
 *   record SCHEDULED + alarmTime <= now  →  record 'FIRED_OR_DUE'
 *   transition NONE/SCHEDULED             →  'FIRED_OR_DUE'
 *
 * FIRED_OR_DUE is TERMINAL for the transition: delivery is UNKNOWN
 * (the alarm may have fired while the app was dead and been dismissed,
 * or never fired), so the foreground must not send on top of it and
 * the claim must never be re-armed for the same transition. Only
 * positive native evidence (applyDeliveredCriticalEvidence) may move
 * it onward to SENT.
 *
 * A due/past claim whose episode is already SENT is left alone (the
 * episode was consumed by the foreground; the record is neutralized at
 * episode end).
 *
 * Every ownership mutation here bumps the medication's ownership
 * revision so in-flight scheduler operations captured before the
 * consumption cannot re-arm the consumed claim.
 */
export function consumeDueScheduledClaim(
  transitions: Record<string, CriticalTransitionState>,
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  ownershipRevisions: Record<string, number>,
  medId: string,
  now: number,
  dirty: ReconcileDirtyFlags
): void {
  const t = transitions[medId];
  if (!t) return;
  const rec = scheduled[medId];
  if (!rec || rec.transitionKey !== t.transitionKey) return;
  // Only episodes whose notification ownership is not yet consumed can
  // move to FIRED_OR_DUE here (SENT is terminal and owned elsewhere).
  if (t.notificationState !== 'NONE' && t.notificationState !== 'SCHEDULED') return;

  let episodeChanged = false;
  if (isScheduledClaimDue(rec, now)) {
    // Firing window reached → consume the claim (delivery UNKNOWN).
    rec.status = 'FIRED_OR_DUE';
    dirty.scheduled = true;
    episodeChanged = true;
  } else if (rec.status === 'FIRED_OR_DUE') {
    // Record already consumed (e.g. a crash between the owner's two
    // store writes) — bring the episode in line.
    episodeChanged = true;
  }
  if (episodeChanged) {
    t.notificationState = 'FIRED_OR_DUE';
    dirty.transitions = true;
    if (bumpEpisodeOwnershipRevision(ownershipRevisions, medId)) {
      dirty.ownership = true;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Delivery evidence (strict semantics)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upgrade episodes from 'SCHEDULED' or 'FIRED_OR_DUE' to 'SENT' using
 * POSITIVE delivery evidence only: the scheduled critical alarm
 * notification is currently visible in the Android notification drawer
 * (LocalNotifications.getDeliveredNotifications).
 *
 * Presence in the drawer proves the notification was displayed. Absence
 * proves nothing (it may have been dismissed) — so absence never
 * changes any state, and elapsed `alarmTime` alone NEVER produces a
 * DELIVERED/SENT transition. Pure function over the stores; performs no
 * I/O so it is trivially testable and cannot race the scheduler's
 * record writes (the caller re-loads the authoritative scheduled map
 * inside its async callback before invoking this).
 *
 * Upgrading the episode changes its notification ownership AND marks
 * the bound claim 'DELIVERED' (persisted positive evidence — the claim
 * becomes terminal), so the medication's ownership revision is bumped:
 * any in-flight scheduler operation captured before the upgrade must
 * not write a SCHEDULED claim for the now-SENT episode.
 *
 * Returns true when any store changed (caller persists transitions +
 * scheduled records + ownership revisions).
 */
export function applyDeliveredCriticalEvidence(
  medIds: string[],
  deliveredNotificationIds: Set<number>,
  transitions: Record<string, CriticalTransitionState>,
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  ownershipRevisions: Record<string, number>,
  alarmIdFor: (medId: string) => number
): boolean {
  let changed = false;
  for (const medId of medIds) {
    const t = transitions[medId];
    if (!t) continue;
    if (t.notificationState !== 'SCHEDULED' && t.notificationState !== 'FIRED_OR_DUE') continue;
    const rec = scheduled[medId];
    if (!rec || rec.transitionKey !== t.transitionKey) continue;
    if (!deliveredNotificationIds.has(alarmIdFor(medId))) continue;
    t.notificationState = 'SENT';
    // Persist the positive evidence on the claim itself: it becomes
    // terminal (never re-armed) and the evidence survives restarts.
    rec.status = 'DELIVERED';
    changed = true;
    if (bumpEpisodeOwnershipRevision(ownershipRevisions, medId)) {
      changed = true;
    }
  }
  return changed;
}
