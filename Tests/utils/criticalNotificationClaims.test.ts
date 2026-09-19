import { describe, it, expect, beforeEach } from 'vitest';
import {
  CRITICAL_CLAIMS_STORAGE_KEY,
  loadCriticalNotificationClaims,
  saveCriticalNotificationClaims,
  getCriticalNotificationClaim,
  setCriticalNotificationClaim,
  clearCriticalNotificationClaim,
  claimsEqual,
 } from '@/utils/criticalNotificationClaims';

describe('criticalNotificationClaims — storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty map when nothing is stored', () => {
    expect(loadCriticalNotificationClaims()).toEqual({});
  });

  it('saves and loads claims round-trip', () => {
    const claims = {
      'med-1': { claimed: true, alarmTime: 12345 },
      'med-2': { claimed: false, alarmTime: null },
    };
    saveCriticalNotificationClaims(claims);
    expect(loadCriticalNotificationClaims()).toEqual(claims);
  });

  it('discards corrupt stored data instead of throwing', () => {
    localStorage.setItem(CRITICAL_CLAIMS_STORAGE_KEY, '{not json');
    expect(loadCriticalNotificationClaims()).toEqual({});
    localStorage.setItem(CRITICAL_CLAIMS_STORAGE_KEY, JSON.stringify({ med: { claimed: 'yes' } }));
    expect(loadCriticalNotificationClaims()).toEqual({});
  });

  it('get / set / clear operate on a loaded map', () => {
    const claims = loadCriticalNotificationClaims();
    expect(getCriticalNotificationClaim(claims, 'med-1')).toBeNull();

    setCriticalNotificationClaim(claims, 'med-1', { claimed: true, alarmTime: 42 });
    expect(getCriticalNotificationClaim(claims, 'med-1')).toEqual({ claimed: true, alarmTime: 42 });

    clearCriticalNotificationClaim(claims, 'med-1');
    expect(getCriticalNotificationClaim(claims, 'med-1')).toBeNull();
  });

  it('claimsEqual compares by value', () => {
    expect(claimsEqual(null, null)).toBe(true);
    expect(claimsEqual(null, { claimed: false, alarmTime: null })).toBe(false);
    expect(claimsEqual({ claimed: true, alarmTime: 5 }, { claimed: true, alarmTime: 5 })).toBe(true);
    expect(claimsEqual({ claimed: true, alarmTime: 5 }, { claimed: true, alarmTime: null })).toBe(false);
    expect(claimsEqual({ claimed: true, alarmTime: null }, { claimed: false, alarmTime: null })).toBe(false);
  });
});

