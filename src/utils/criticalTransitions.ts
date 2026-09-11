/**
 * Authoritative persistent state for critical-stock episodes.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   1. Critical transition identity (one per continuous critical episode).
 *   2. Scheduled critical-alarm records (pure scheduling data, separate).
 *   3. The one authoritative episode reconcile algorithm shared by
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
 * - Scheduled-record writes are funneled through the ownership helpers
 *   below: the episode owner binds (bindScheduledAlarmToTransition), the
 *   scheduler only updates scheduling data (updateScheduledAlarm /
 *   invalidateScheduledAlarm / clearScheduledAlarm) with generation
 *   checks so a stale scheduler operation can never clobber the record
 *   written by a newer one, erase a binding to the active episode, or
 *   resurrect a binding to a dead one.
 *
 * == Storage versioning / migration ==
 *   v2 (current): android_med_tracker_critical_transition_v2
 *                 android_med_tracker_scheduled_critical_v2
 *   Legacy (read-once migration sources, then removed):
 *     - android_med_tracker_critical_transition_v1
 *     - android_med_tracker_critical_notified_v2
 *     - android_med_tracker_scheduled_critical_v1
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
  if (rec.notificationState === 'SCHEDULED' || rec.notificationState === 'SENT' || rec.notificationState === 'NONE') {
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
  if (raw === 'SCHEDULED' || raw === 'DELIVERED' || raw === 'NOT_SCHEDULED') return raw;
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
//       (bindScheduledAlarmToTransition) and neutralizes its own
//       episode's claim at episode end
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
}

/**
 * SCHEDULER ONLY: persist the outcome of a SUCCESSFUL native schedule
 * (the alarm is armed at `update.alarmTime`).
 *
 * Binding rule (the heart of the ownership model):
 *   transitionKey := the ACTIVE transition's key for this med, or ''
 *   when no episode is currently active.
 *
 * Consequences:
 *   - a record already bound to the active episode KEEPS that binding
 *     (the alarm time can change; the episode identity cannot);
 *   - a stale binding to a dead episode is dropped, never resurrected;
 *   - an unbound claim stays unbound when no episode is active;
 *   - when an episode IS active, the claim becomes its bound claim.
 *
 * The scheduler never generates an identity here — it only reads the
 * authoritative transition map passed by the caller.
 *
 * Generation rule: the write is ABANDONED (returns false, no mutation)
 * when the stored record's generation differs from the operation's
 * baseline — i.e. another scheduler write landed while this operation
 * was awaiting the native bridge. Accepted writes bump generation.
 *
 * Returns true when the map changed (caller persists).
 */
export function updateScheduledAlarm(
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  transitions: Record<string, CriticalTransitionState>,
  medId: string,
  update: ScheduledAlarmUpdate
): boolean {
  const existing = scheduled[medId];
  // Stale-generation protection: only the write whose baseline still
  // matches the stored record may proceed.
  if (existing && (existing.generation ?? 0) !== update.baselineGeneration) {
    return false;
  }
  // READ (never create) the authoritative episode identity.
  const activeKey = getActiveTransition(transitions, medId)?.transitionKey ?? '';
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
    return false;
  }
  scheduled[medId] = next;
  return true;
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
 * Reconcile ONE medication's critical-episode state against the two
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
 *             (transition deleted + bound scheduled claim cleared)
 *
 * Notification ownership:
 *   Path A (foreground): NONE ──send──► SENT
 *   Path B (scheduled):  a validly-registered alarm owns the episode's
 *   single notification → adopted transition gets notificationState
 *   'SCHEDULED' and the foreground stays quiet. A failed scheduling
 *   attempt (status NOT_SCHEDULED) is NOT a valid claim → the
 *   foreground path remains available.
 */
export function reconcileCriticalEpisode(
  transitions: Record<string, CriticalTransitionState>,
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
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
      // never adopt/suppress a FUTURE episode (new key, new claim).
      if (rec && rec.transitionKey === t.transitionKey && rec.status !== 'NOT_SCHEDULED') {
        rec.status = 'NOT_SCHEDULED';
        dirty.scheduled = true;
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
    // (a) ADOPT a pending scheduled claim: an alarm was successfully
    //     registered for this med and its (projected) fire time has
    //     passed — the crossing most likely happened while the app was
    //     dead and the native alarm was displayed. The claim becomes the
    //     episode identity and keeps notification ownership
    //     ('SCHEDULED'). If the record already carries delivery evidence
    //     (status DELIVERED), the episode is 'SENT' immediately.
    //     NB: we do NOT convert elapsed time into delivery — the record
    //     stays SCHEDULED; only positive evidence upgrades it.
    // (b) FRESH episode: crossing detected in the foreground (or no
    //     valid claim exists — including failed scheduling). The key is
    //     generated ONCE here and persisted immediately.
    const adoptableClaim = Boolean(
      rec && rec.status === 'SCHEDULED' && rec.alarmTime <= now
    );
    const deliveredClaim = Boolean(rec && rec.status === 'DELIVERED');

    if (adoptableClaim || deliveredClaim) {
      const key = rec!.transitionKey || generateCriticalTransitionKey(medId, now);
      t = {
        transitionKey: key,
        enteredAt: rec!.alarmTime > 0 ? rec!.alarmTime : now,
        notificationState: deliveredClaim ? 'SENT' : 'SCHEDULED',
      };
      // Owner bind: the adopted claim carries this episode's identity.
      if (bindScheduledAlarmToTransition(scheduled, medId, key)) {
        dirty.scheduled = true;
      }
    } else {
      t = {
        transitionKey: generateCriticalTransitionKey(medId, now),
        enteredAt: now,
        notificationState: 'NONE',
      };
      // Bind a still-pending (future) alarm to this episode so it can
      // never be mistaken for another episode's claim later. A FUTURE
      // alarm does not suppress the foreground — the crossing already
      // happened earlier than projected, and the scheduler cancels the
      // stale alarm right after (same React commit).
      if (
        rec &&
        rec.status === 'SCHEDULED' &&
        bindScheduledAlarmToTransition(scheduled, medId, t.transitionKey)
      ) {
        dirty.scheduled = true;
      }
    }
    transitions[medId] = t;
    dirty.transitions = true;
    created = true;
  }

  // ── Claim-evidence upgrade (Path B ownership after the fact) ──
  // The episode began with notificationState NONE (e.g. alerts were
  // disabled at crossing) while a pending alarm was bound to it. If
  // that bound claim has since elapsed or carries delivery evidence,
  // the scheduled path OWNS the episode's single notification — the
  // foreground must never send on top of it.
  // NB: elapsed time only moves NONE → SCHEDULED (ownership), NEVER to
  // SENT/'DELIVERED' — only positive evidence proves delivery.
  if (t.notificationState === 'NONE' && rec && rec.transitionKey === t.transitionKey) {
    if (rec.status === 'DELIVERED') {
      t.notificationState = 'SENT';
      dirty.transitions = true;
    } else if (rec.status === 'SCHEDULED' && rec.alarmTime <= now) {
      t.notificationState = 'SCHEDULED';
      dirty.transitions = true;
    }
  }

  // Migrated/already-recorded delivery evidence on the bound record
  // upgrades an adopted SCHEDULED episode to SENT without any async work.
  if (
    t.notificationState === 'SCHEDULED' &&
    rec &&
    rec.transitionKey === t.transitionKey &&
    rec.status === 'DELIVERED'
  ) {
    t.notificationState = 'SENT';
    dirty.transitions = true;
  }

  // ── Foreground notification decision (Path A) ──
  let notificationSent = false;
  if (t.notificationState === 'NONE') {
    // Reached only when no valid scheduled claim owns this episode
    // (ownership upgrades above have already consumed that case). A
    // failed scheduling attempt (NOT_SCHEDULED) and a still-future
    // claim both leave the foreground path available.
    if (canNotify) {
      send();
      // Mark optimistically BEFORE the async send resolves: the send
      // helper never rejects (errors are caught internally), and marking
      // first guarantees at-most-once even if the app dies mid-send.
      t.notificationState = 'SENT';
      dirty.transitions = true;
      notificationSent = true;
    }
    // canNotify false → state stays 'NONE'. Disabling alerts must NOT
    // consume the episode: re-enabling while still critical allows
    // exactly one notification.
  }

  return { transition: t, created, notificationSent };
}

// ─────────────────────────────────────────────────────────────────────
// Delivery evidence (strict semantics)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upgrade adopted episodes from 'SCHEDULED' to 'SENT' using POSITIVE
 * delivery evidence only: the scheduled critical alarm notification is
 * currently visible in the Android notification drawer
 * (LocalNotifications.getDeliveredNotifications).
 *
 * Presence in the drawer proves the notification was displayed. Absence
 * proves nothing (it may have been dismissed) — so absence never
 * changes any state, and elapsed `alarmTime` alone NEVER produces a
 * DELIVERED/SENT transition. Pure function over the stores; performs no
 * I/O so it is trivially testable and cannot race the scheduler's
 * record writes (it never writes the scheduled store).
 *
 * Returns true when any transition changed (caller persists transitions).
 */
export function applyDeliveredCriticalEvidence(
  medIds: string[],
  deliveredNotificationIds: Set<number>,
  transitions: Record<string, CriticalTransitionState>,
  scheduled: Record<string, ScheduledCriticalAlarmRecord>,
  alarmIdFor: (medId: string) => number
): boolean {
  let changed = false;
  for (const medId of medIds) {
    const t = transitions[medId];
    if (!t || t.notificationState !== 'SCHEDULED') continue;
    const rec = scheduled[medId];
    if (!rec || rec.transitionKey !== t.transitionKey) continue;
    if (!deliveredNotificationIds.has(alarmIdFor(medId))) continue;
    t.notificationState = 'SENT';
    changed = true;
  }
  return changed;
}
