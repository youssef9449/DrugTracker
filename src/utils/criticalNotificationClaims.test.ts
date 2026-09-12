import { describe, it, expect, beforeEach } from 'vitest';
import {
  CRITICAL_CLAIMS_STORAGE_KEY,
  loadCriticalNotificationClaims,
  saveCriticalNotificationClaims,
  getCriticalNotificationClaim,
  setCriticalNotificationClaim,
  clearCriticalNotificationClaim,
  claimsEqual,
  migrateLegacyClaims,
} from './criticalNotificationClaims';

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

describe('criticalNotificationClaims — legacy migration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('runs once: migrates legacy stores, persists v3, removes legacy keys', () => {
    localStorage.setItem(
      'android_med_tracker_critical_transition_v2',
      JSON.stringify({
        'med-consumed': { transitionKey: 'crit_a', enteredAt: 1, notificationState: 'SENT' },
        'med-open': { transitionKey: 'crit_b', enteredAt: 2, notificationState: 'NONE' },
      })
    );
    localStorage.setItem(
      'android_med_tracker_scheduled_critical_v2',
      JSON.stringify({
        'med-future': { transitionKey: '', alarmTime: Date.now() + 86_400_000, status: 'SCHEDULED' },
      })
    );
    localStorage.setItem(
      'android_med_tracker_critical_ownership_v2',
      JSON.stringify({ 'med-consumed': { revision: 3 } })
    );

    const claims = loadCriticalNotificationClaims();

    // Consumed episode → claimed (no duplicate on upgrade).
    expect(claims['med-consumed']).toEqual({ claimed: true, alarmTime: null });
    // Episode that never consumed its opportunity → stays open.
    expect(claims['med-open']).toEqual({ claimed: false, alarmTime: null });
    // Armed future alarm without an episode → claim carried with its time.
    expect(claims['med-future']?.claimed).toBe(true);
    expect(typeof claims['med-future']?.alarmTime).toBe('number');

    // Persisted under v3; legacy keys (transitions, scheduled, ownership) removed.
    expect(localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem('android_med_tracker_critical_transition_v2')).toBeNull();
    expect(localStorage.getItem('android_med_tracker_scheduled_critical_v2')).toBeNull();
    expect(localStorage.getItem('android_med_tracker_critical_ownership_v2')).toBeNull();

    // Second load is a plain read (no re-migration).
    expect(loadCriticalNotificationClaims()).toEqual(claims);
  });

  it('migrates FIRED_OR_DUE and SCHEDULED episodes as consumed', () => {
    const claims = migrateLegacyClaims(
      {
        a: { transitionKey: 'k', enteredAt: 1, notificationState: 'FIRED_OR_DUE' },
        b: { transitionKey: 'k', enteredAt: 1, notificationState: 'SCHEDULED' },
      },
      {}
    );
    expect(claims.a).toEqual({ claimed: true, alarmTime: null });
    expect(claims.b).toEqual({ claimed: true, alarmTime: null });
  });

  // ── Regression: a valid FUTURE scheduled alarm must survive migration ──

  it('Test A — SCHEDULED transition + valid future alarm preserves the alarm time', () => {
    const t = Date.now() + 24 * 60 * 60 * 1000;
    const claims = migrateLegacyClaims(
      { med1: { transitionKey: 'k1', enteredAt: 123, notificationState: 'SCHEDULED' } },
      { med1: { transitionKey: 'k1', alarmTime: t, status: 'SCHEDULED' } }
    );
    expect(claims.med1).toEqual({ claimed: true, alarmTime: t });
  });

  it('Test B — SCHEDULED transition + elapsed alarm migrates as consumed (no fake future)', () => {
    const t = Date.now() - 60 * 60 * 1000;
    const claims = migrateLegacyClaims(
      { med1: { transitionKey: 'k1', enteredAt: 123, notificationState: 'SCHEDULED' } },
      { med1: { transitionKey: 'k1', alarmTime: t, status: 'SCHEDULED' } }
    );
    expect(claims.med1).toEqual({ claimed: true, alarmTime: null });
  });

  it('Test C — SENT transition + still-future scheduled record does NOT resurrect the alarm', () => {
    const t = Date.now() + 24 * 60 * 60 * 1000;
    const claims = migrateLegacyClaims(
      { med1: { transitionKey: 'k1', enteredAt: 123, notificationState: 'SENT' } },
      { med1: { transitionKey: 'k1', alarmTime: t, status: 'SCHEDULED' } }
    );
    // The foreground notification already consumed the opportunity —
    // never resurrect a scheduled alarm for it.
    expect(claims.med1).toEqual({ claimed: true, alarmTime: null });
  });

  it('Test D — NONE transition + valid future alarm preserves the alarm time', () => {
    const t = Date.now() + 24 * 60 * 60 * 1000;
    const claims = migrateLegacyClaims(
      { med1: { transitionKey: 'k1', enteredAt: 123, notificationState: 'NONE' } },
      { med1: { transitionKey: 'k1', alarmTime: t, status: 'SCHEDULED' } }
    );
    expect(claims.med1).toEqual({ claimed: true, alarmTime: t });
  });

  it('Test E — NONE transition + no scheduled alarm migrates as an open opportunity', () => {
    const claims = migrateLegacyClaims(
      { med1: { transitionKey: 'k1', enteredAt: 123, notificationState: 'NONE' } },
      {}
    );
    expect(claims.med1).toEqual({ claimed: false, alarmTime: null });
  });

  it('FIRED_OR_DUE transition + still-future scheduled record stays consumed (stale residue)', () => {
    const t = Date.now() + 24 * 60 * 60 * 1000;
    const claims = migrateLegacyClaims(
      { med1: { transitionKey: 'k1', enteredAt: 123, notificationState: 'FIRED_OR_DUE' } },
      { med1: { transitionKey: 'k1', alarmTime: t, status: 'SCHEDULED' } }
    );
    expect(claims.med1).toEqual({ claimed: true, alarmTime: null });
  });

  it('NONE transition + elapsed scheduled alarm migrates as consumed (prevents duplicate)', () => {
    const t = Date.now() - 60 * 60 * 1000;
    const claims = migrateLegacyClaims(
      { med1: { transitionKey: 'k1', enteredAt: 123, notificationState: 'NONE' } },
      { med1: { transitionKey: 'k1', alarmTime: t, status: 'SCHEDULED' } }
    );
    // The armed alarm already came due — delivery state is not
    // reconstructed, so the opportunity migrates as consumed instead of
    // risking a duplicate foreground notification after the upgrade.
    expect(claims.med1).toEqual({ claimed: true, alarmTime: null });
  });

  it('migrates a NONE episode with an armed future alarm as claimed with its alarm time', () => {
    const t = Date.now() + 86_400_000;
    const claims = migrateLegacyClaims(
      { a: { transitionKey: 'k', enteredAt: 1, notificationState: 'NONE' } },
      { a: { transitionKey: 'k', alarmTime: t, status: 'SCHEDULED' } }
    );
    expect(claims.a).toEqual({ claimed: true, alarmTime: t });
  });

  it('migrates a scheduled record with no status (pre-status format) by its alarm time', () => {
    const t = Date.now() + 86_400_000;
    const claims = migrateLegacyClaims({}, { a: { transitionKey: '', alarmTime: t } });
    expect(claims.a).toEqual({ claimed: true, alarmTime: t });

    const claimsNoAlarm = migrateLegacyClaims({}, { b: { transitionKey: '', alarmTime: 0 } });
    expect(claimsNoAlarm.b).toEqual({ claimed: false, alarmTime: null });
  });
});
