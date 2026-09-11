import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CRITICAL_TRANSITION_STORAGE_KEY,
  SCHEDULED_CRITICAL_STORAGE_KEY,
  LEGACY_TRANSITION_V1_KEY,
  LEGACY_CRITICAL_NOTIFIED_KEY,
  LEGACY_SCHEDULED_V1_KEY,
  generateCriticalTransitionKey,
  loadCriticalTransitions,
  saveCriticalTransitions,
  loadScheduledCriticalAlarms,
  saveScheduledCriticalAlarms,
  reconcileCriticalEpisode,
  applyDeliveredCriticalEvidence,
  getActiveTransition,
  bindScheduledAlarmToTransition,
  updateScheduledAlarm,
  invalidateScheduledAlarm,
  clearScheduledAlarm,
} from './criticalTransitions';
import { CriticalTransitionState, ScheduledCriticalAlarmRecord } from '../types';

let localStorageStore: Record<string, string> = {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  localStorageStore = {};
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
    return localStorageStore[key] ?? null;
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
    localStorageStore[key] = value;
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
    delete localStorageStore[key];
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function writeTransitions(map: Record<string, CriticalTransitionState>): void {
  localStorageStore[CRITICAL_TRANSITION_STORAGE_KEY] = JSON.stringify(map);
}

function writeScheduled(map: Record<string, ScheduledCriticalAlarmRecord>): void {
  localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify(map);
}

/** Run one reconcile pass for a single med and persist like the hook does. */
function pass(opts: {
  medId?: string;
  isCriticalish: boolean;
  canNotify?: boolean;
  now?: number;
}) {
  const transitions = loadCriticalTransitions();
  const scheduled = loadScheduledCriticalAlarms();
  const dirty = { transitions: false, scheduled: false };
  let sent = 0;
  const result = reconcileCriticalEpisode(
    transitions,
    scheduled,
    {
      medId: opts.medId ?? 'med-1',
      isCriticalish: opts.isCriticalish,
      canNotify: opts.canNotify ?? true,
      now: opts.now ?? Date.now(),
      send: () => { sent++; },
    },
    dirty
  );
  if (dirty.transitions) saveCriticalTransitions(transitions);
  if (dirty.scheduled) saveScheduledCriticalAlarms(scheduled);
  return { result, sent };
}

describe('generateCriticalTransitionKey', () => {
  it('generates unique keys for the same med (episodes must never share an identity)', () => {
    const a = generateCriticalTransitionKey('med-1');
    const b = generateCriticalTransitionKey('med-1');
    expect(a).not.toBe(b);
    expect(a).toContain('med-1');
  });

  it('embeds no semantics: same med + different generation times are still just unique opaque keys', () => {
    const atDate1 = generateCriticalTransitionKey('med-1', 1730000000000);
    const atDate2 = generateCriticalTransitionKey('med-1', 1740000000000);
    // Unique per call (episodes must never share an identity).
    expect(atDate1).not.toBe(atDate2);
    // The random suffix makes the key non-reconstructible from
    // medId + time alone (device clock jumps cannot collide episodes).
    const a = generateCriticalTransitionKey('med-1', 1730000000000);
    const b = generateCriticalTransitionKey('med-1', 1730000000000);
    expect(a).not.toBe(b);
  });
});

describe('loadCriticalTransitions — migration', () => {
  it('returns v2 data verbatim when present', () => {
    writeTransitions({
      'med-1': { transitionKey: 'k1', enteredAt: 42, notificationState: 'SCHEDULED' },
    });
    const loaded = loadCriticalTransitions();
    expect(loaded['med-1']).toEqual({ transitionKey: 'k1', enteredAt: 42, notificationState: 'SCHEDULED' });
  });

  it('migrates v1 transition map (notificationSent boolean → notificationState) and removes legacy keys', () => {
    localStorageStore[LEGACY_TRANSITION_V1_KEY] = JSON.stringify({
      'med-1': { transitionKey: 'v1key', enteredAt: 1000, notificationSent: true },
      'med-2': { transitionKey: 'v1key2', enteredAt: 2000, notificationSent: false },
    });
    const loaded = loadCriticalTransitions();
    expect(loaded['med-1']).toEqual({ transitionKey: 'v1key', enteredAt: 1000, notificationState: 'SENT' });
    expect(loaded['med-2']).toEqual({ transitionKey: 'v1key2', enteredAt: 2000, notificationState: 'NONE' });
    // v2 persisted; legacy removed.
    expect(localStorageStore[CRITICAL_TRANSITION_STORAGE_KEY]).toBeDefined();
    expect(localStorageStore[LEGACY_TRANSITION_V1_KEY]).toBeUndefined();
    expect(localStorageStore[LEGACY_CRITICAL_NOTIFIED_KEY]).toBeUndefined();
  });

  it('migrates the legacy notified map with enteredAt 0 (never a misleading Date.now())', () => {
    localStorageStore[LEGACY_CRITICAL_NOTIFIED_KEY] = JSON.stringify({
      'med-1': 'legacy_key_1',
    });
    const loaded = loadCriticalTransitions();
    expect(loaded['med-1']).toEqual({
      transitionKey: 'legacy_key_1',
      enteredAt: 0,
      notificationState: 'SENT',
    });
    expect(localStorageStore[LEGACY_CRITICAL_NOTIFIED_KEY]).toBeUndefined();
  });

  it('v1 transitions take precedence over the legacy notified map', () => {
    localStorageStore[LEGACY_TRANSITION_V1_KEY] = JSON.stringify({
      'med-1': { transitionKey: 'v1', enteredAt: 5, notificationSent: false },
    });
    localStorageStore[LEGACY_CRITICAL_NOTIFIED_KEY] = JSON.stringify({ 'med-1': 'legacy' });
    const loaded = loadCriticalTransitions();
    expect(loaded['med-1'].transitionKey).toBe('v1');
  });

  it('drops malformed entries during migration instead of crashing', () => {
    localStorageStore[LEGACY_TRANSITION_V1_KEY] = JSON.stringify({
      'med-1': { transitionKey: 'ok', enteredAt: 1, notificationSent: true },
      'med-bad': { noKey: true },
      'med-also-bad': 'garbage',
    });
    const loaded = loadCriticalTransitions();
    expect(Object.keys(loaded)).toEqual(['med-1']);
  });
});

describe('loadScheduledCriticalAlarms — migration & normalization', () => {
  it('returns normalized v2 records', () => {
    writeScheduled({
      'med-1': { transitionKey: '', alarmTime: 123, status: 'SCHEDULED' },
    });
    expect(loadScheduledCriticalAlarms()['med-1']).toEqual({
      transitionKey: '',
      alarmTime: 123,
      status: 'SCHEDULED',
    });
  });

  it('migrates v1 records, normalizing missing status from alarmTime', () => {
    localStorageStore[LEGACY_SCHEDULED_V1_KEY] = JSON.stringify({
      'med-1': { transitionKey: 'oldkey', alarmTime: 555 },
      'med-2': { alarmTime: 0 },
    });
    const loaded = loadScheduledCriticalAlarms();
    expect(loaded['med-1']).toEqual({ transitionKey: 'oldkey', alarmTime: 555, status: 'SCHEDULED' });
    expect(loaded['med-2']).toEqual({ transitionKey: '', alarmTime: 0, status: 'NOT_SCHEDULED' });
    expect(localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY]).toBeDefined();
    expect(localStorageStore[LEGACY_SCHEDULED_V1_KEY]).toBeUndefined();
  });
});

describe('reconcileCriticalEpisode — episode lifecycle', () => {
  it('creates the transition once on sufficient → critical and sends one notification', () => {
    const { result, sent } = pass({ isCriticalish: true });
    expect(result?.created).toBe(true);
    expect(result?.transition.notificationState).toBe('SENT');
    expect(sent).toBe(1);

    const stored = loadCriticalTransitions()['med-1'];
    expect(stored.transitionKey).toBe(result!.transition.transitionKey);
  });

  it('keeps the SAME key across repeated critical passes (renders, days, mutations)', () => {
    const first = pass({ isCriticalish: true });
    const keyA = first.result!.transition.transitionKey;

    // Simulate: next day, auto deduction, manual consume — all still critical.
    vi.setSystemTime(new Date('2024-09-11T12:00:00Z'));
    const second = pass({ isCriticalish: true, now: Date.now() });
    vi.setSystemTime(new Date('2024-09-12T12:00:00Z'));
    const third = pass({ isCriticalish: true, now: Date.now() });

    expect(second.result!.created).toBe(false);
    expect(third.result!.created).toBe(false);
    expect(second.result!.transition.transitionKey).toBe(keyA);
    expect(third.result!.transition.transitionKey).toBe(keyA);
    // No additional notifications.
    expect(second.sent).toBe(0);
    expect(third.sent).toBe(0);
  });

  it('critical → out_of_stock keeps the SAME key and sends no second notification', () => {
    const first = pass({ isCriticalish: true });
    const keyA = first.result!.transition.transitionKey;

    const oos = pass({ isCriticalish: true }); // now out_of_stock (still criticalish)
    expect(oos.result!.transition.transitionKey).toBe(keyA);
    expect(oos.sent).toBe(0);
  });

  it('critical → sufficient ENDS the episode (record removed, bound claim neutralized)', () => {
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime: Date.now() + 1000, status: 'SCHEDULED' } });
    const first = pass({ isCriticalish: true });
    const keyA = first.result!.transition.transitionKey;
    // The future claim got bound to the episode.
    expect(loadScheduledCriticalAlarms()['med-1'].transitionKey).toBe(keyA);

    pass({ isCriticalish: false }); // refill → sufficient

    expect(loadCriticalTransitions()['med-1']).toBeUndefined();
    expect(loadScheduledCriticalAlarms()['med-1'].status).toBe('NOT_SCHEDULED');
  });

  it('sufficient → critical AGAIN creates a NEW key (B ≠ A)', () => {
    const first = pass({ isCriticalish: true });
    const keyA = first.result!.transition.transitionKey;

    pass({ isCriticalish: false });
    const second = pass({ isCriticalish: true });
    const keyB = second.result!.transition.transitionKey;

    expect(second.result!.created).toBe(true);
    expect(keyB).not.toBe(keyA);
    expect(second.sent).toBe(1);
  });

  it('canNotify=false creates the episode with NONE (never SENT); re-enabling sends exactly once', () => {
    const first = pass({ isCriticalish: true, canNotify: false });
    expect(first.result!.transition.notificationState).toBe('NONE');
    expect(first.sent).toBe(0);

    const second = pass({ isCriticalish: true, canNotify: true });
    expect(second.sent).toBe(1);
    expect(second.result!.transition.notificationState).toBe('SENT');

    const third = pass({ isCriticalish: true, canNotify: true });
    expect(third.sent).toBe(0);
  });
});

describe('reconcileCriticalEpisode — scheduled claim interaction', () => {
  it('ADOPTS an elapsed SCHEDULED claim: binds the key, marks SCHEDULED, does NOT send', () => {
    const alarmTime = Date.now() - 3600000;
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' } });

    const { result, sent } = pass({ isCriticalish: true });

    expect(sent).toBe(0);
    expect(result!.transition.notificationState).toBe('SCHEDULED');
    expect(result!.transition.transitionKey).toMatch(/^crit_med-1_/);
    expect(result!.transition.enteredAt).toBe(alarmTime);
    expect(loadScheduledCriticalAlarms()['med-1'].transitionKey).toBe(result!.transition.transitionKey);
  });

  it('adopting a bound claim preserves its identity (adopt, never re-generate)', () => {
    writeScheduled({
      'med-1': { transitionKey: 'crit_med-1_ARMED_CLAIM', alarmTime: Date.now() - 1, status: 'SCHEDULED' },
    });

    const { result, sent } = pass({ isCriticalish: true });
    expect(result!.transition.transitionKey).toBe('crit_med-1_ARMED_CLAIM');
    expect(sent).toBe(0);
  });

  it('a DELIVERED claim (recorded evidence) adopts as SENT without sending', () => {
    writeScheduled({
      'med-1': { transitionKey: '', alarmTime: Date.now() - 3600000, status: 'DELIVERED' },
    });

    const { result, sent } = pass({ isCriticalish: true });
    expect(sent).toBe(0);
    expect(result!.transition.notificationState).toBe('SENT');
  });

  it('a NOT_SCHEDULED record (failed scheduling) is NOT a claim → fresh episode + foreground send', () => {
    writeScheduled({
      'med-1': { transitionKey: '', alarmTime: Date.now() - 3600000, status: 'NOT_SCHEDULED' },
    });

    const { result, sent } = pass({ isCriticalish: true });
    expect(sent).toBe(1);
    expect(result!.created).toBe(true);
    expect(result!.transition.notificationState).toBe('SENT');
  });

  it('a FUTURE SCHEDULED alarm does not suppress the foreground and gets bound to the new episode', () => {
    const alarmTime = Date.now() + 86400000;
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' } });

    const { result, sent } = pass({ isCriticalish: true });
    expect(sent).toBe(1);
    expect(result!.transition.notificationState).toBe('SENT');
    expect(loadScheduledCriticalAlarms()['med-1'].transitionKey).toBe(result!.transition.transitionKey);
  });

  it('a NONE-state episode with a bound claim that has since elapsed does NOT re-notify (scheduled path owns it)', () => {
    // Episode began while alerts were disabled, with a future claim bound.
    const alarmTime = Date.now() + 86400000;
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' } });
    const first = pass({ isCriticalish: true, canNotify: false });
    expect(first.sent).toBe(0);

    // Time passes; the native alarm fires while the app is dead.
    vi.setSystemTime(new Date('2024-09-13T12:00:00Z'));

    const second = pass({ isCriticalish: true, canNotify: true, now: Date.now() });
    // The scheduled alarm is the authoritative path → foreground quiet.
    expect(second.sent).toBe(0);
    expect(second.result!.transition.notificationState).toBe('SCHEDULED');
  });

  it('changed alarmTime (rescheduling) does NOT change the episode key', () => {
    const first = pass({ isCriticalish: true, canNotify: false });
    const keyA = first.result!.transition.transitionKey;

    // Scheduler reschedules: new projected date for the SAME episode claim.
    const scheduled = loadScheduledCriticalAlarms();
    scheduled['med-1'] = { transitionKey: keyA, alarmTime: Date.now() + 999999, status: 'SCHEDULED' };
    saveScheduledCriticalAlarms(scheduled);

    const second = pass({ isCriticalish: true, canNotify: false });
    expect(second.result!.transition.transitionKey).toBe(keyA);
  });
});

describe('applyDeliveredCriticalEvidence', () => {
  const alarmIdFor = (medId: string) => medId.length;

  it('upgrades SCHEDULED → SENT only with POSITIVE evidence (id present in drawer)', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'k1', enteredAt: 0, notificationState: 'SCHEDULED' },
      'med-22': { transitionKey: 'k2', enteredAt: 0, notificationState: 'SCHEDULED' },
    };
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'k1', alarmTime: 1, status: 'SCHEDULED' },
      'med-22': { transitionKey: 'k2', alarmTime: 2, status: 'SCHEDULED' },
    };

    // Only med-1's alarm is in the drawer.
    const changed = applyDeliveredCriticalEvidence(
      ['med-1', 'med-22'],
      new Set([alarmIdFor('med-1')]),
      transitions,
      scheduled,
      alarmIdFor
    );

    expect(changed).toBe(true);
    expect(transitions['med-1'].notificationState).toBe('SENT');
    expect(transitions['med-22'].notificationState).toBe('SCHEDULED'); // no evidence → unchanged
  });

  it('never touches episodes that are NONE or SENT', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'k1', enteredAt: 0, notificationState: 'NONE' },
      'med-2': { transitionKey: 'k2', enteredAt: 0, notificationState: 'SENT' },
    };
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'k1', alarmTime: 1, status: 'SCHEDULED' },
      'med-2': { transitionKey: 'k2', alarmTime: 2, status: 'SCHEDULED' },
    };

    applyDeliveredCriticalEvidence(['med-1', 'med-2'], new Set([1, 2]), transitions, scheduled, alarmIdFor);
    expect(transitions['med-1'].notificationState).toBe('NONE');
    expect(transitions['med-2'].notificationState).toBe('SENT');
  });

  it('ignores claims whose key does not match the active episode', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'k-current', enteredAt: 0, notificationState: 'SCHEDULED' },
    };
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'k-stale', alarmTime: 1, status: 'SCHEDULED' },
    };

    const changed = applyDeliveredCriticalEvidence(
      ['med-1'],
      new Set([alarmIdFor('med-1')]),
      transitions,
      scheduled,
      alarmIdFor
    );
    expect(changed).toBe(false);
    expect(transitions['med-1'].notificationState).toBe('SCHEDULED');
  });
});

describe('save/load round-trip', () => {
  it('persists and reloads both stores faithfully', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: generateCriticalTransitionKey('med-1'), enteredAt: 9, notificationState: 'SCHEDULED' },
    };
    saveCriticalTransitions(transitions);
    expect(loadCriticalTransitions()).toEqual(transitions);

    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: '', alarmTime: 123456, status: 'SCHEDULED' },
      'med-2': { transitionKey: 'k2', alarmTime: 42, status: 'NOT_SCHEDULED', generation: 3 },
    };
    saveScheduledCriticalAlarms(scheduled);
    expect(loadScheduledCriticalAlarms()).toEqual(scheduled);
  });

  it('drops a malformed generation instead of crashing (defensive normalization)', () => {
    writeScheduled({
      'med-1': { transitionKey: '', alarmTime: 5, status: 'SCHEDULED', generation: 'bogus' } as unknown as ScheduledCriticalAlarmRecord,
      'med-2': { transitionKey: '', alarmTime: 6, status: 'SCHEDULED', generation: -3 } as unknown as ScheduledCriticalAlarmRecord,
    });
    const loaded = loadScheduledCriticalAlarms();
    expect(loaded['med-1'].generation).toBeUndefined();
    expect(loaded['med-2'].generation).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scheduled-record ownership / versioning helpers (race-safety layer)
// ─────────────────────────────────────────────────────────────────────

describe('getActiveTransition', () => {
  it('returns the active transition, or null when none exists', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' },
    };
    expect(getActiveTransition(transitions, 'med-1')).toEqual(transitions['med-1']);
    expect(getActiveTransition(transitions, 'med-missing')).toBeNull();
    expect(getActiveTransition({}, 'med-1')).toBeNull();
  });
});

describe('bindScheduledAlarmToTransition — episode-owner bind', () => {
  it('binds an unbound claim to the episode', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: '', alarmTime: 100, status: 'SCHEDULED' },
    };
    expect(bindScheduledAlarmToTransition(scheduled, 'med-1', 'A')).toBe(true);
    expect(scheduled['med-1'].transitionKey).toBe('A');
    // Scheduling data untouched.
    expect(scheduled['med-1'].alarmTime).toBe(100);
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
  });

  it('replaces a stale binding from a previous episode (the owner is authoritative)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'OLD', alarmTime: 100, status: 'SCHEDULED' },
    };
    expect(bindScheduledAlarmToTransition(scheduled, 'med-1', 'A')).toBe(true);
    expect(scheduled['med-1'].transitionKey).toBe('A');
  });

  it('is a no-op when already bound to the episode, when the key is empty, or when no record exists', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'A', alarmTime: 100, status: 'SCHEDULED' },
      'med-2': { transitionKey: '', alarmTime: 200, status: 'NOT_SCHEDULED' },
    };
    expect(bindScheduledAlarmToTransition(scheduled, 'med-1', 'A')).toBe(false);
    expect(bindScheduledAlarmToTransition(scheduled, 'med-2', '')).toBe(false);
    expect(bindScheduledAlarmToTransition(scheduled, 'med-missing', 'A')).toBe(false);
  });
});

describe('updateScheduledAlarm — scheduler write rule (ownership + generation)', () => {
  const mkRecord = (over: Partial<ScheduledCriticalAlarmRecord> = {}): ScheduledCriticalAlarmRecord => ({
    transitionKey: '',
    alarmTime: Date.now() + 86400000,
    status: 'SCHEDULED',
    ...over,
  });
  const mkTransition = (key: string): CriticalTransitionState => ({
    transitionKey: key,
    enteredAt: 1,
    notificationState: 'SENT',
  });

  it('TEST A: scheduler writes unbound claim → owner binds it to Transition A → scheduler reschedules ⇒ key A remains', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ alarmTime: 1000 }), // G1 wrote an unbound claim (generation absent → 0)
    };
    // Owner binds the claim to the active episode (reconcile at the crossing).
    bindScheduledAlarmToTransition(scheduled, 'med-1', 'A');
    const transitions = { 'med-1': mkTransition('A') };

    // Scheduler reschedules with a new projected date.
    const changed = updateScheduledAlarm(scheduled, transitions, 'med-1', {
      alarmTime: 9999,
      baselineGeneration: 0,
    });

    expect(changed).toBe(true);
    expect(scheduled['med-1'].transitionKey).toBe('A'); // binding NOT erased
    expect(scheduled['med-1'].alarmTime).toBe(9999);
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(scheduled['med-1'].generation).toBe(1);
  });

  it('TEST B: claim already bound to A; scheduler changes alarmTime ⇒ same key A, new alarmTime', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ transitionKey: 'A', alarmTime: 1000, generation: 4 }),
    };
    const transitions = { 'med-1': mkTransition('A') };

    updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 5555, baselineGeneration: 4 });

    expect(scheduled['med-1'].transitionKey).toBe('A');
    expect(scheduled['med-1'].alarmTime).toBe(5555);
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(scheduled['med-1'].generation).toBe(5);
  });

  it('binds the claim to the ACTIVE transition even when the stored record was unbound', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ transitionKey: '', generation: 2 }),
    };
    const transitions = { 'med-1': mkTransition('A') };

    updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 777, baselineGeneration: 2 });

    expect(scheduled['med-1'].transitionKey).toBe('A');
  });

  it('stale binding to a dead episode is dropped and the ACTIVE transition wins (no resurrection)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ transitionKey: 'DEAD', generation: 1 }),
    };
    const transitions = { 'med-1': mkTransition('A') };

    updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 777, baselineGeneration: 1 });

    expect(scheduled['med-1'].transitionKey).toBe('A');
    expect(scheduled['med-1'].transitionKey).not.toBe('DEAD');
  });

  it('writes an UNBOUND claim when no episode is active — even if the old record was bound (dead binding dropped)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ transitionKey: 'DEAD', generation: 1 }),
    };
    const transitions = {}; // episode ended — no active transition

    updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 777, baselineGeneration: 1 });

    expect(scheduled['med-1'].transitionKey).toBe('');
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
  });

  it('creates the record when none exists (unbound when no episode is active)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {};
    const transitions = {};

    expect(updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 123, baselineGeneration: 0 })).toBe(true);

    expect(scheduled['med-1']).toEqual({
      transitionKey: '',
      alarmTime: 123,
      status: 'SCHEDULED',
      generation: 1,
    });
  });

  it('TEST C (storage level): an older generation ABANDONS the write when the record moved on', () => {
    // G2 already wrote the record (generation 2, bound to A, alarmTime 42).
    const stored = mkRecord({ transitionKey: 'A', alarmTime: 42, generation: 2 });
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = { 'med-1': stored };
    const transitions = { 'med-1': mkTransition('A') };

    // G1 (stale, baseline 0) tries to write afterwards.
    const changed = updateScheduledAlarm(scheduled, transitions, 'med-1', {
      alarmTime: 111,
      baselineGeneration: 0,
    });

    expect(changed).toBe(false);
    // Persistent record still belongs to G2/current state — untouched.
    expect(scheduled['med-1']).toEqual(stored);
    expect(scheduled['med-1'].alarmTime).toBe(42);
    expect(scheduled['med-1'].generation).toBe(2);
  });

  it('skips the write (no revision) when the scheduling data is unchanged', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ transitionKey: '', alarmTime: 777, generation: 3 }),
    };
    const transitions = {};

    expect(updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 777, baselineGeneration: 3 })).toBe(false);
    expect(scheduled['med-1'].generation).toBe(3); // unchanged
  });
});

describe('invalidateScheduledAlarm — scheduler neutralize rule', () => {
  it('neutralizes SCHEDULED → NOT_SCHEDULED, preserving the binding and bumping the generation', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'A', alarmTime: 100, status: 'SCHEDULED', generation: 1 },
    };
    expect(invalidateScheduledAlarm(scheduled, 'med-1', 1)).toBe(true);
    expect(scheduled['med-1'].status).toBe('NOT_SCHEDULED');
    expect(scheduled['med-1'].transitionKey).toBe('A'); // binding preserved (informational)
    expect(scheduled['med-1'].generation).toBe(2);
  });

  it('neutralizes a DELIVERED record too (delivery evidence lives in the transition store)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'A', alarmTime: 100, status: 'DELIVERED' },
    };
    expect(invalidateScheduledAlarm(scheduled, 'med-1', 0)).toBe(true);
    expect(scheduled['med-1'].status).toBe('NOT_SCHEDULED');
  });

  it('no-op when already NOT_SCHEDULED, when the med has no record, or on a stale generation', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'A', alarmTime: 100, status: 'NOT_SCHEDULED', generation: 2 },
      'med-2': { transitionKey: '', alarmTime: 100, status: 'SCHEDULED', generation: 5 },
    };
    expect(invalidateScheduledAlarm(scheduled, 'med-1', 2)).toBe(false);
    expect(invalidateScheduledAlarm(scheduled, 'med-missing', 0)).toBe(false);
    // Stored generation 5 ≠ stale baseline 3 → abandon.
    expect(invalidateScheduledAlarm(scheduled, 'med-2', 3)).toBe(false);
    expect(scheduled['med-2'].status).toBe('SCHEDULED');
    expect(scheduled['med-2'].generation).toBe(5);
  });

  it('works without a baseline check (owner-style synchronous use)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'A', alarmTime: 100, status: 'SCHEDULED' },
    };
    expect(invalidateScheduledAlarm(scheduled, 'med-1')).toBe(true);
    expect(scheduled['med-1'].status).toBe('NOT_SCHEDULED');
    expect(scheduled['med-1'].generation).toBeUndefined(); // untouched without a baseline
  });
});

describe('clearScheduledAlarm — deleted-med cleanup', () => {
  it('removes the record entirely', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'A', alarmTime: 1, status: 'SCHEDULED', generation: 7 },
    };
    expect(clearScheduledAlarm(scheduled, 'med-1', 7)).toBe(true);
    expect(scheduled['med-1']).toBeUndefined();
  });

  it('abandons the delete on a stale generation and no-ops without a record', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': { transitionKey: 'A', alarmTime: 1, status: 'SCHEDULED', generation: 7 },
    };
    expect(clearScheduledAlarm(scheduled, 'med-1', 3)).toBe(false);
    expect(scheduled['med-1']).toBeDefined();
    expect(clearScheduledAlarm(scheduled, 'med-missing', 0)).toBe(false);
  });
});

describe('reconcileCriticalEpisode — TEST E: a new episode never inherits the previous claim', () => {
  it('A ends (claim neutralized) → B begins ⇒ B key ≠ A and the leftover claim of A cannot suppress B', () => {
    // Episode A begins with a future claim that gets bound to it.
    writeScheduled({
      'med-1': { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'SCHEDULED' },
    });
    const first = pass({ isCriticalish: true, canNotify: true });
    const keyA = first.result!.transition.transitionKey;
    expect(first.sent).toBe(1); // foreground owned A's notification (future claim does not suppress)
    expect(loadScheduledCriticalAlarms()['med-1'].transitionKey).toBe(keyA);

    // Refill → episode A ends: transition deleted, bound claim neutralized.
    pass({ isCriticalish: false });
    expect(loadCriticalTransitions()['med-1']).toBeUndefined();
    const leftover = loadScheduledCriticalAlarms()['med-1'];
    expect(leftover.status).toBe('NOT_SCHEDULED');
    expect(leftover.transitionKey).toBe(keyA); // binding kept only as inert information

    // New crossing → episode B.
    const second = pass({ isCriticalish: true, canNotify: true });
    const keyB = second.result!.transition.transitionKey;

    expect(second.result!.created).toBe(true);
    expect(keyB).not.toBe(keyA);          // NEW identity — never inherited
    expect(second.sent).toBe(1);          // A's neutralized leftover claim does NOT suppress B
    expect(second.result!.transition.notificationState).toBe('SENT');
  });

  it('an ELAPSED claim bound to a dead episode cannot be adopted by the new episode B', () => {
    // A pathological leftover: a SCHEDULED elapsed record still bound to
    // the dead episode A (e.g. a crash between the owner's cleanup steps).
    writeScheduled({
      'med-1': { transitionKey: 'crit_med-1_DEAD_A', alarmTime: Date.now() - 3600000, status: 'SCHEDULED' },
    });

    // The scheduler reschedules (med sufficient, no active episode):
    // the dead binding is dropped — the claim becomes unbound with the
    // NEW armed alarm time, so it can never adopt A's identity later.
    const scheduled = loadScheduledCriticalAlarms();
    const transitions = loadCriticalTransitions();
    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 86400000,
        baselineGeneration: scheduled['med-1'].generation ?? 0,
      })
    ).toBe(true);
    saveScheduledCriticalAlarms(scheduled);
    expect(scheduled['med-1'].transitionKey).toBe('');

    // Later crossing: the fresh episode gets its OWN key — A is gone.
    const { result, sent } = pass({ isCriticalish: true, canNotify: true });
    expect(sent).toBe(1); // future claim → foreground; no inheritance from A
    expect(result!.transition.transitionKey).not.toBe('crit_med-1_DEAD_A');
  });
});
