/**
 * Shared Critical Stock claim localStorage helpers for frontend tests.
 * Keeps claim read/write shape consistent without global mutable state.
 */
import { CRITICAL_CLAIMS_STORAGE_KEY } from '../../src/utils/criticalNotificationClaims';

export type CriticalClaimRecord = { claimed: boolean; alarmTime: number | null };
export type CriticalClaimsMap = Record<string, CriticalClaimRecord>;

export function readCriticalClaims(): CriticalClaimsMap {
  try {
    const raw = localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as CriticalClaimsMap;
  } catch {
    return {};
  }
}

export function writeCriticalClaims(claims: CriticalClaimsMap): void {
  localStorage.setItem(CRITICAL_CLAIMS_STORAGE_KEY, JSON.stringify(claims));
}

export function writeCriticalClaim(
  medId: string,
  claim: CriticalClaimRecord
): void {
  const claims = readCriticalClaims();
  claims[medId] = claim;
  writeCriticalClaims(claims);
}

export function clearCriticalClaims(): void {
  localStorage.removeItem(CRITICAL_CLAIMS_STORAGE_KEY);
}
