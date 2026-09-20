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
 */

import type { CriticalNotificationClaim } from '../types';
import { loadJson, saveJson } from './storage';
import { OperationQueue } from './async/OperationQueue';

export const CRITICAL_CLAIMS_STORAGE_KEY = 'android_med_tracker_critical_claims_v3';

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

/**
 * Load the current claims map from storage.
 * Missing / invalid store → empty map.
 */
export function loadCriticalNotificationClaims(): Record<string, CriticalNotificationClaim> {
  const raw = loadJson<unknown>(CRITICAL_CLAIMS_STORAGE_KEY, null);
  if (!isValidClaimsMap(raw)) {
    return {};
  }
  return { ...raw };
}

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

const criticalAlarmOperationQueue = new OperationQueue<string>();

/**
 * Append an async native-alarm operation to the per-medication queue.
 * Business ownership/generation rules remain in the calling feature code.
 */
export function enqueueCriticalAlarmOp(
  medId: string,
  op: () => Promise<void>
): Promise<void> {
  return criticalAlarmOperationQueue.enqueue(medId, op);
}
