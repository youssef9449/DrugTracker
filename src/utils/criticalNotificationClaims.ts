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
 * versioned key. All access is synchronous localStorage (via the
 * runtime-validated readJsonOutcome reader and the persist writer), so a
 * read-decide-write pass is atomic with respect to other
 * JS code (single-threaded) as long as callers do not await in between.
 */

import type { CriticalNotificationClaim } from '../types';
import { persist, readJsonOutcome, type JsonParserVerdict } from './storage';
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
 * Outcome-aware claims read. Claim state is the cross-tab "already notified"
 * authority: a present-but-invalid store must never be treated as "no claims"
 * (that would allow duplicate notifications). Claim-decision callers use this
 * and fail closed; the convenience loader below stays for enumeration-only
 * reads where an unreadable map cannot cause a duplicate delivery.
 */
export type CriticalClaimsRead =
  | { status: 'ok'; claims: Record<string, CriticalNotificationClaim> }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'read_failed' };

export function readCriticalNotificationClaimsOutcome(): CriticalClaimsRead {
  const outcome = readJsonOutcome(
    CRITICAL_CLAIMS_STORAGE_KEY,
    (raw): JsonParserVerdict<Record<string, CriticalNotificationClaim>> =>
      isValidClaimsMap(raw)
        ? { ok: true, value: raw as Record<string, CriticalNotificationClaim> }
        : { ok: false, reason: 'critical_claims_shape_invalid' }
  );
  switch (outcome.status) {
    case 'ok':
      return { status: 'ok', claims: { ...outcome.value } };
    case 'missing':
      return { status: 'missing' };
    case 'read_failed':
      return { status: 'read_failed' };
    default:
      return { status: 'invalid' };
  }
}

/**
 * Load the current claims map from storage.
 * Missing / invalid store → empty map (with a diagnostic for invalid).
 * Claim DECISIONS must use {@link readCriticalNotificationClaimsOutcome} and
 * fail closed on invalid — an empty map here is only safe for enumeration.
 */
export function loadCriticalNotificationClaims(): Record<string, CriticalNotificationClaim> {
  const outcome = readCriticalNotificationClaimsOutcome();
  if (outcome.status === 'invalid' || outcome.status === 'read_failed') {
    console.warn(
      `[critical-claims] claims store unusable (${outcome.status}); treating as empty for enumeration only.`
    );
    return {};
  }
  return outcome.status === 'ok' ? outcome.claims : {};
}

export function saveCriticalNotificationClaims(claims: Record<string, CriticalNotificationClaim>): boolean {
  if (persist(CRITICAL_CLAIMS_STORAGE_KEY, claims) !== null) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY) === JSON.stringify(claims);
  } catch {
    return false;
  }
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
