import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CRITICAL_TRANSITION_STORAGE_KEY,
  SCHEDULED_CRITICAL_STORAGE_KEY,
  CRITICAL_OWNERSHIP_STORAGE_KEY,
  LEGACY_TRANSITION_V1_KEY,
  LEGACY_CRITICAL_NOTIFIED_KEY,
  LEGACY_SCHEDULED_V1_KEY,
  generateCriticalTransitionKey,
  loadCriticalTransitions,
  saveCriticalTransitions,
  loadScheduledCriticalAlarms,
  saveScheduledCriticalAlarms,
  loadOwnershipRevisions,
  saveOwnershipRevisions,
  reconcileCriticalEpisode,
  consumeDueScheduledClaim,
  applyDeliveredCriticalEvidence,
  getActiveTransition,
  bindScheduledAlarmToTransition,
  updateScheduledAlarm,
  invalidateScheduledAlarm,
  clearScheduledAlarm,
  invalidateEpisodeOwnership,
  bumpEpisodeOwnershipRevision,
  getOwnershipRevision,
  canScheduleForTransition,
  captureSchedulingContext,
  isSchedulingContextStillValid,
  getScheduledClaimPhase,
  isScheduledClaimFuture,
  isScheduledClaimDue,
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

function writeOwnership(map: Record<string, number>): void {
  localStorageStore[CRITICAL_OWNERSHIP_STORAGE_KEY] = JSON.stringify(map);
}

function readOwnership(): Record<string, number> {
  const raw = localStorageStore[CRITICAL_OWNERSHIP_STORAGE_KEY];
  return raw ? JSON.parse(raw) : {};
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
  const ownershipRevisions = loadOwnershipRevisions();
  const dirty = { transitions: false, scheduled: false, ownership: false };
  let sent = 0;
  const result = reconcileCriticalEpisode(
    transitions,
    scheduled,
    ownershipRevisions,
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
  if (dirty.ownership) saveOwnershipRevisions(ownershipRevisions);
  return { result, sent, ownershipRevisions };
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
  it('ADOPTS an elapsed SCHEDULED claim: binds the key, marks FIRED_OR_DUE (delivery unknown), does NOT send', () => {
    const alarmTime = Date.now() - 3600000;
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' } });

    const { result, sent } = pass({ isCriticalish: true });

    expect(sent).toBe(0);
    // The claim's firing window already passed at adoption time: the
    // episode is FIRED_OR_DUE (delivery UNKNOWN) — never SCHEDULED-as-
    // if-pending and never SENT (elapsed time is not delivery).
    expect(result!.transition.notificationState).toBe('FIRED_OR_DUE');
    expect(result!.transition.transitionKey).toMatch(/^crit_med-1_/);
    expect(result!.transition.enteredAt).toBe(alarmTime);
    const rec = loadScheduledCriticalAlarms()['med-1'];
    expect(rec.transitionKey).toBe(result!.transition.transitionKey);
    // The claim itself is consumed — it can never be re-armed.
    expect(rec.status).toBe('FIRED_OR_DUE');
  });

  it('an already-FIRED_OR_DUE unbound claim adopts as FIRED_OR_DUE too (terminal, no re-notify)', () => {
    const alarmTime = Date.now() - 3600000;
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'FIRED_OR_DUE' } });

    const { result, sent } = pass({ isCriticalish: true });
    expect(sent).toBe(0);
    expect(result!.transition.notificationState).toBe('FIRED_OR_DUE');
    expect(loadScheduledCriticalAlarms()['med-1'].status).toBe('FIRED_OR_DUE');
  });

  it('a BOUND elapsed claim is NEVER adopted (dead-episode leftover → neutralized + fresh identity + foreground)', () => {
    // A claim still bound to a key at creation time belonged to an
    // episode that has since ended (e.g. a crash between the owner's
    // two store writes). The new episode must never inherit it.
    writeScheduled({
      'med-1': { transitionKey: 'crit_med-1_DEAD_EPISODE', alarmTime: Date.now() - 1, status: 'SCHEDULED' },
    });

    const { result, sent } = pass({ isCriticalish: true });
    expect(result!.created).toBe(true);
    expect(result!.transition.transitionKey).not.toBe('crit_med-1_DEAD_EPISODE');
    // The leftover was neutralized, NOT rebound: its elapsed alarm must
    // not own (suppress the foreground of) the NEW episode.
    expect(loadScheduledCriticalAlarms()['med-1'].status).toBe('NOT_SCHEDULED');
    expect(loadScheduledCriticalAlarms()['med-1'].transitionKey).toBe('crit_med-1_DEAD_EPISODE');
    expect(result!.transition.notificationState).toBe('SENT');
    expect(sent).toBe(1);
    // Ownership revision moved: the new episode invalidates in-flight
    // scheduler operations captured before it existed.
    expect(getOwnershipRevision(readOwnership(), 'med-1')).toBeGreaterThan(0);
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

  it('a NONE-state episode with a bound claim that has since elapsed becomes FIRED_OR_DUE (claim consumed, no re-notify)', () => {
    // Episode began while alerts were disabled, with a future claim bound.
    const alarmTime = Date.now() + 86400000;
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' } });
    const first = pass({ isCriticalish: true, canNotify: false });
    expect(first.sent).toBe(0);

    // Time passes; the native alarm fires while the app is dead.
    vi.setSystemTime(new Date('2024-09-13T12:00:00Z'));

    const second = pass({ isCriticalish: true, canNotify: true, now: Date.now() });
    // The scheduled alarm consumed this episode's notification
    // opportunity (delivery unknown) → foreground quiet, claim terminal.
    expect(second.sent).toBe(0);
    expect(second.result!.transition.notificationState).toBe('FIRED_OR_DUE');
    expect(loadScheduledCriticalAlarms()['med-1'].status).toBe('FIRED_OR_DUE');
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
    const ownership: Record<string, number> = { 'med-1': 4, 'med-22': 2 };
    const changed = applyDeliveredCriticalEvidence(
      ['med-1', 'med-22'],
      new Set([alarmIdFor('med-1')]),
      transitions,
      scheduled,
      ownership,
      alarmIdFor
    );

    expect(changed).toBe(true);
    expect(transitions['med-1'].notificationState).toBe('SENT');
    expect(transitions['med-22'].notificationState).toBe('SCHEDULED'); // no evidence → unchanged
    // The ownership revision moved for the upgraded episode (ownership
    // state changed → in-flight scheduler operations are invalidated).
    expect(ownership['med-1']).toBe(5);
    expect(ownership['med-22']).toBe(2);
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

    applyDeliveredCriticalEvidence(
      ['med-1', 'med-2'], new Set([1, 2]), transitions, scheduled, {}, alarmIdFor
    );
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
      {},
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
    // NONE = the active episode's notification is not yet owned by any
    // path, so a scheduler write may create the SCHEDULED claim. The
    // SENT refusal is covered by dedicated tests below.
    notificationState: 'NONE',
  });

  it('TEST A: scheduler writes unbound claim → owner binds it to Transition A → scheduler reschedules ⇒ key A remains', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      // G1 wrote an unbound PENDING claim (generation absent → 0).
      'med-1': mkRecord({ alarmTime: Date.now() + 1000 }),
    };
    // Owner binds the claim to the active episode (reconcile at the crossing).
    bindScheduledAlarmToTransition(scheduled, 'med-1', 'A');
    const transitions = { 'med-1': mkTransition('A') };

    // Scheduler reschedules with a new (still future) projected date.
    const changed = updateScheduledAlarm(scheduled, transitions, 'med-1', {
      alarmTime: Date.now() + 9999,
      baselineGeneration: 0,
      now: Date.now(),
    });

    expect(changed).toBe('persisted');
    expect(scheduled['med-1'].transitionKey).toBe('A'); // binding NOT erased
    expect(scheduled['med-1'].alarmTime).toBe(Date.now() + 9999);
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(scheduled['med-1'].generation).toBe(1);
  });

  it('TEST B: claim already bound to A; scheduler changes alarmTime ⇒ same key A, new alarmTime', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ transitionKey: 'A', alarmTime: Date.now() + 1000, generation: 4 }),
    };
    const transitions = { 'med-1': mkTransition('A') };

    updateScheduledAlarm(scheduled, transitions, 'med-1', {
      alarmTime: Date.now() + 5555,
      baselineGeneration: 4,
      now: Date.now(),
    });

    expect(scheduled['med-1'].transitionKey).toBe('A');
    expect(scheduled['med-1'].alarmTime).toBe(Date.now() + 5555);
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

    expect(updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 123, baselineGeneration: 0 })).toBe('persisted');

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

    expect(changed).toBe('refused');
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

    expect(updateScheduledAlarm(scheduled, transitions, 'med-1', { alarmTime: 777, baselineGeneration: 3 })).toBe('unchanged');
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
    ).toBe('persisted');
    saveScheduledCriticalAlarms(scheduled);
    expect(scheduled['med-1'].transitionKey).toBe('');

    // Later crossing: the fresh episode gets its OWN key — A is gone.
    const { result, sent } = pass({ isCriticalish: true, canNotify: true });
    expect(sent).toBe(1); // future claim → foreground; no inheritance from A
    expect(result!.transition.transitionKey).not.toBe('crit_med-1_DEAD_A');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Ownership-revision store (episode-vs-scheduler race safety)
// ─────────────────────────────────────────────────────────────────────

describe('ownership-revision store', () => {
  it('starts empty; missing entries read as 0', () => {
    expect(loadOwnershipRevisions()).toEqual({});
    expect(getOwnershipRevision(loadOwnershipRevisions(), 'med-1')).toBe(0);
  });

  it('bump increments, initializes missing entries to 1, and reports changes', () => {
    const revisions: Record<string, number> = {};
    expect(bumpEpisodeOwnershipRevision(revisions, 'med-1')).toBe(true);
    expect(revisions['med-1']).toBe(1);
    expect(bumpEpisodeOwnershipRevision(revisions, 'med-1')).toBe(true);
    expect(revisions['med-1']).toBe(2);
    // Persisted and reloaded faithfully.
    saveOwnershipRevisions(revisions);
    expect(loadOwnershipRevisions()).toEqual(revisions);
  });

  it('normalization drops malformed entries instead of crashing', () => {
    writeOwnership({ 'med-1': 3, 'med-2': -5, 'med-3': 'x' } as unknown as Record<string, number>);
    writeOwnership({ 'med-1': 3, 'med-2': -5, 'med-4': 1.5 });
    // 1.5 is finite + non-negative → kept (any monotonic value is safe).
    expect(loadOwnershipRevisions()).toEqual({ 'med-1': 3, 'med-4': 1.5 });
  });
});

describe('canScheduleForTransition — SENT ownership rule', () => {
  it('allows scheduling when no episode is active', () => {
    expect(canScheduleForTransition({}, 'med-1')).toBe(true);
  });

  it('allows scheduling for NONE and SCHEDULED episodes', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'k1', enteredAt: 1, notificationState: 'NONE' },
      'med-2': { transitionKey: 'k2', enteredAt: 1, notificationState: 'SCHEDULED' },
    };
    expect(canScheduleForTransition(transitions, 'med-1')).toBe(true);
    expect(canScheduleForTransition(transitions, 'med-2')).toBe(true);
  });

  it('REFUSES scheduling for a SENT episode (its notification was consumed)', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'k1', enteredAt: 1, notificationState: 'SENT' },
    };
    expect(canScheduleForTransition(transitions, 'med-1')).toBe(false);
  });

  it('REFUSES scheduling for a FIRED_OR_DUE episode (the claim window was consumed)', () => {
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'k1', enteredAt: 1, notificationState: 'FIRED_OR_DUE' },
    };
    expect(canScheduleForTransition(transitions, 'med-1')).toBe(false);
  });
});

describe('updateScheduledAlarm — BLOCKER 2: SENT can never become SCHEDULED', () => {
  const mkRecord = (over: Partial<ScheduledCriticalAlarmRecord> = {}): ScheduledCriticalAlarmRecord => ({
    transitionKey: 'A',
    alarmTime: Date.now() + 86400000,
    status: 'NOT_SCHEDULED',
    generation: 3,
    ...over,
  });

  it('refuses the write entirely when the active episode is SENT (record untouched)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord(),
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SENT' },
    };

    const changed = updateScheduledAlarm(scheduled, transitions, 'med-1', {
      alarmTime: Date.now() + 999999,
      baselineGeneration: 3,
    });

    expect(changed).toBe('refused');
    // No SCHEDULED ownership was restored, no binding/alarmTime touched.
    expect(scheduled['med-1']).toEqual(mkRecord());
  });

  it('refuses even when the record does not exist yet (no new claim for a SENT episode)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {};
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SENT' },
    };

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 999999,
        baselineGeneration: 0,
      })
    ).toBe('refused');
    expect(scheduled['med-1']).toBeUndefined();
  });

  it('a NONE episode MAY gain a SCHEDULED claim (legitimate ownership handoff)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ status: 'NOT_SCHEDULED', transitionKey: '' }),
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' },
    };

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: 12345,
        baselineGeneration: 3,
      })
    ).toBe('persisted');
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(scheduled['med-1'].transitionKey).toBe('A');
  });

  it('a SCHEDULED episode MAY have its alarmTime updated (same identity)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ status: 'SCHEDULED' }),
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' },
    };

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: 4242,
        baselineGeneration: 3,
      })
    ).toBe('persisted');
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(scheduled['med-1'].transitionKey).toBe('A');
    expect(scheduled['med-1'].alarmTime).toBe(4242);
  });

  it('a FIRED_OR_DUE episode can NEVER regain a SCHEDULED claim (consumed window stays terminal)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ status: 'FIRED_OR_DUE', alarmTime: Date.now() - 1000 }),
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'FIRED_OR_DUE' },
    };

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 999999,
        baselineGeneration: 3,
      })
    ).toBe('refused');
    expect(scheduled['med-1'].status).toBe('FIRED_OR_DUE');
  });

  it('a consumed claim (FIRED_OR_DUE) bound to the ACTIVE transition is never re-armed', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ status: 'FIRED_OR_DUE', alarmTime: Date.now() - 1000 }),
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' },
    };

    // Even if the episode state lagged behind (crash between the
    // owner's two writes), a consumed claim bound to the active
    // transition must not be resurrected as SCHEDULED.
    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 999999,
        baselineGeneration: 3,
      })
    ).toBe('refused');
    expect(scheduled['med-1'].status).toBe('FIRED_OR_DUE');
  });

  it('a consumed claim (DELIVERED evidence) bound to the ACTIVE transition is never re-armed', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ status: 'DELIVERED', alarmTime: Date.now() - 1000 }),
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' },
    };

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 999999,
        baselineGeneration: 3,
      })
    ).toBe('refused');
    expect(scheduled['med-1'].status).toBe('DELIVERED');
  });

  it('a consumed claim bound to a DEAD episode may be overwritten by a genuinely new opportunity', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': mkRecord({ transitionKey: 'DEAD', status: 'FIRED_OR_DUE', alarmTime: Date.now() - 1000 }),
    };
    // Episode A ended; no active episode exists. The new projected
    // crossing is a genuinely new notification opportunity.
    const transitions = {};

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 999999,
        baselineGeneration: 3,
      })
    ).toBe('persisted');
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(scheduled['med-1'].transitionKey).toBe('');
  });
});

describe('captureSchedulingContext / isSchedulingContextStillValid', () => {
  const capture = () =>
    captureSchedulingContext(loadCriticalTransitions(), loadScheduledCriticalAlarms(), loadOwnershipRevisions(), 'med-1');
  const stillValid = (ctx: ReturnType<typeof capture>) =>
    isSchedulingContextStillValid(ctx, loadCriticalTransitions(), loadScheduledCriticalAlarms(), loadOwnershipRevisions());

  it('valid when nothing ownership-relevant changed', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 1000, status: 'SCHEDULED', generation: 4 } });
    writeOwnership({ 'med-1': 7 });

    const ctx = capture();
    expect(stillValid(ctx)).toBe(true);
    expect(ctx).toEqual({
      medId: 'med-1',
      baselineTransitionKey: 'A',
      baselineNotificationState: 'NONE',
      baselineOwnershipRevision: 7,
      baselineRecordGeneration: 4,
      baselineRecordTransitionKey: 'A',
    });
  });

  it('valid with no episode and no record (all baselines zero/empty)', () => {
    const ctx = capture();
    expect(ctx.baselineTransitionKey).toBe('');
    expect(ctx.baselineNotificationState).toBeNull();
    expect(ctx.baselineOwnershipRevision).toBe(0);
    expect(ctx.baselineRecordGeneration).toBe(0);
    expect(ctx.baselineRecordTransitionKey).toBe('');
    expect(stillValid(ctx)).toBe(true);
  });

  it('INVALID after the episode ends (revision bumped by the owner)', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 1000, status: 'SCHEDULED', generation: 4 } });
    writeOwnership({ 'med-1': 7 });
    const ctx = capture();

    // Owner ends the episode (exactly what reconcileCriticalEpisode does):
    // transition deleted, bound claim neutralized, revision bumped.
    const revisions = loadOwnershipRevisions();
    const dirty = { transitions: false, scheduled: false, ownership: false };
    reconcileCriticalEpisode(
      loadCriticalTransitions(),
      loadScheduledCriticalAlarms(),
      revisions,
      { medId: 'med-1', isCriticalish: false, canNotify: true, now: Date.now(), send: () => undefined },
      dirty
    );
    saveOwnershipRevisions(revisions);

    expect(stillValid(ctx)).toBe(false);
  });

  it('INVALID when a new episode B replaced episode A (transitionKey changed)', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SENT' } });
    const ctx = capture();

    writeTransitions({ 'med-1': { transitionKey: 'B', enteredAt: 2, notificationState: 'NONE' } });
    expect(stillValid(ctx)).toBe(false);
  });

  it('INVALID when notification ownership changed NONE → SENT under the operation', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' } });
    const ctx = capture();

    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SENT' } });
    expect(stillValid(ctx)).toBe(false);
  });

  it('INVALID when a newer scheduler write replaced the record (generation moved)', () => {
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime: 1000, status: 'SCHEDULED', generation: 2 } });
    const ctx = capture();

    writeScheduled({ 'med-1': { transitionKey: '', alarmTime: 2000, status: 'SCHEDULED', generation: 3 } });
    expect(stillValid(ctx)).toBe(false);
  });

  it('INVALID when the owner bound the record (binding moved without a generation bump)', () => {
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime: 1000, status: 'SCHEDULED', generation: 2 } });
    const ctx = capture();

    const scheduled = loadScheduledCriticalAlarms();
    bindScheduledAlarmToTransition(scheduled, 'med-1', 'A');
    saveScheduledCriticalAlarms(scheduled);
    expect(stillValid(ctx)).toBe(false);
  });

  it('INVALID when the record disappeared entirely', () => {
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime: 1000, status: 'SCHEDULED', generation: 2 } });
    const ctx = capture();

    writeScheduled({});
    expect(stillValid(ctx)).toBe(false);
  });
});

describe('invalidateEpisodeOwnership — owner-side end-of-episode invalidation', () => {
  it('neutralizes the claim bound to the dead episode AND bumps the revision', () => {
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 1000, status: 'SCHEDULED', generation: 2 } });
    const scheduled = loadScheduledCriticalAlarms();
    const revisions: Record<string, number> = {};

    expect(invalidateEpisodeOwnership(scheduled, revisions, 'med-1', 'A')).toBe(true);
    expect(scheduled['med-1'].status).toBe('NOT_SCHEDULED');
    expect(scheduled['med-1'].transitionKey).toBe('A'); // binding kept as inert info
    expect(scheduled['med-1'].generation).toBe(2);      // owner writes do not bump scheduler generation
    expect(revisions['med-1']).toBe(1);
  });

  it('leaves a claim bound to ANOTHER key alone but still bumps the revision', () => {
    writeScheduled({ 'med-1': { transitionKey: 'OLDER', alarmTime: 1000, status: 'SCHEDULED' } });
    const scheduled = loadScheduledCriticalAlarms();
    const revisions: Record<string, number> = { 'med-1': 5 };

    expect(invalidateEpisodeOwnership(scheduled, revisions, 'med-1', 'A')).toBe(true);
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(revisions['med-1']).toBe(6);
  });

  it('bumps the revision even when no record exists (med deletion cleanup)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {};
    const revisions: Record<string, number> = {};

    expect(invalidateEpisodeOwnership(scheduled, revisions, 'med-1', 'A')).toBe(true);
    expect(scheduled['med-1']).toBeUndefined();
    expect(revisions['med-1']).toBe(1);
  });
});

describe('reconcileCriticalEpisode — ownership-revision bumps', () => {
  it('bumps on episode creation and again on the foreground send', () => {
    const first = pass({ isCriticalish: true, canNotify: true });
    // creation + NONE → SENT
    expect(getOwnershipRevision(readOwnership(), 'med-1')).toBe(2);
    expect(first.sent).toBe(1);
  });

  it('bumps on episode end', () => {
    pass({ isCriticalish: true, canNotify: true });
    const before = getOwnershipRevision(readOwnership(), 'med-1');
    pass({ isCriticalish: false });
    expect(getOwnershipRevision(readOwnership(), 'med-1')).toBe(before + 1);
  });

  it('bumps when the claim consumption moves NONE → FIRED_OR_DUE', () => {
    // Episode begins (disabled alerts) with a future claim bound to it.
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'SCHEDULED' } });
    pass({ isCriticalish: true, canNotify: false });
    const afterCreate = getOwnershipRevision(readOwnership(), 'med-1');

    // The alarm elapsed while the app was dead → the claim is consumed
    // (delivery unknown) and the episode's ownership moves to
    // FIRED_OR_DUE — notification ownership changed.
    vi.setSystemTime(new Date('2024-09-13T12:00:00Z'));
    pass({ isCriticalish: true, canNotify: true, now: Date.now() });

    expect(readOwnership()['med-1']).toBe(afterCreate + 1);
    expect(loadCriticalTransitions()['med-1'].notificationState).toBe('FIRED_OR_DUE');
  });

  it('does NOT bump when a reconcile pass changes nothing (repeated renders/restarts)', () => {
    pass({ isCriticalish: true, canNotify: true });
    const before = readOwnership()['med-1'];
    pass({ isCriticalish: true, canNotify: true });
    pass({ isCriticalish: true, canNotify: true });
    expect(readOwnership()['med-1']).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────
// FIRED_OR_DUE: due/past claim consumption (the "alarm fired while the
// app was dead, user dismissed it, app reopens" duplicate guard)
// ─────────────────────────────────────────────────────────────────────

describe('getScheduledClaimPhase — claim lifecycle classification', () => {
  const rec = (over: Partial<ScheduledCriticalAlarmRecord>): ScheduledCriticalAlarmRecord => ({
    transitionKey: '',
    alarmTime: 1000,
    status: 'SCHEDULED',
    ...over,
  });

  it('SCHEDULED + future alarmTime ⇒ PENDING_FUTURE (reliable evidence the alarm is still pending)', () => {
    const future = rec({ alarmTime: 2000 });
    expect(getScheduledClaimPhase(future, 1000)).toBe('PENDING_FUTURE');
    expect(isScheduledClaimFuture(future, 1000)).toBe(true);
    expect(isScheduledClaimDue(future, 1000)).toBe(false);
  });

  it('SCHEDULED + past alarmTime ⇒ DUE_OR_PAST (delivery UNKNOWN — never delivery evidence)', () => {
    const due = rec({ alarmTime: 500 });
    expect(getScheduledClaimPhase(due, 1000)).toBe('DUE_OR_PAST');
    expect(isScheduledClaimDue(due, 1000)).toBe(true);
    expect(isScheduledClaimFuture(due, 1000)).toBe(false);
    // Exactly-at-now is also due (the window has been reached).
    expect(isScheduledClaimDue(rec({ alarmTime: 1000 }), 1000)).toBe(true);
  });

  it('FIRED_OR_DUE ⇒ CONSUMED_WINDOW; DELIVERED ⇒ DELIVERED; NOT_SCHEDULED ⇒ INVALID; missing ⇒ NO_CLAIM', () => {
    expect(getScheduledClaimPhase(rec({ status: 'FIRED_OR_DUE' }), 1000)).toBe('CONSUMED_WINDOW');
    expect(getScheduledClaimPhase(rec({ status: 'DELIVERED' }), 1000)).toBe('DELIVERED');
    expect(getScheduledClaimPhase(rec({ status: 'NOT_SCHEDULED' }), 1000)).toBe('INVALID');
    expect(getScheduledClaimPhase(undefined, 1000)).toBe('NO_CLAIM');
    // Elapsed time NEVER manufactures delivery evidence.
    expect(isScheduledClaimDue(rec({ status: 'FIRED_OR_DUE' }), 1000)).toBe(false);
  });
});

describe('consumeDueScheduledClaim — owner-side claim consumption', () => {
  const dirty = () => ({ transitions: false, scheduled: false, ownership: false });

  it('consumes a bound due claim: record FIRED_OR_DUE + episode SCHEDULED → FIRED_OR_DUE + revision bump', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 500, status: 'SCHEDULED' } });
    writeOwnership({ 'med-1': 3 });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const revisions = loadOwnershipRevisions();
    const d = dirty();
    consumeDueScheduledClaim(transitions, scheduled, revisions, 'med-1', 1000, d);

    expect(d.scheduled).toBe(true);
    expect(d.transitions).toBe(true);
    expect(d.ownership).toBe(true);
    expect(scheduled['med-1'].status).toBe('FIRED_OR_DUE');
    expect(transitions['med-1'].notificationState).toBe('FIRED_OR_DUE');
    expect(revisions['med-1']).toBe(4);
  });

  it('moves a NONE episode with a bound due claim to FIRED_OR_DUE (the claim owns the notification)', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 500, status: 'SCHEDULED' } });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const revisions = loadOwnershipRevisions();
    const d = dirty();
    consumeDueScheduledClaim(transitions, scheduled, revisions, 'med-1', 1000, d);

    expect(transitions['med-1'].notificationState).toBe('FIRED_OR_DUE');
    expect(scheduled['med-1'].status).toBe('FIRED_OR_DUE');
  });

  it('repairs a crash between the owner writes: record FIRED_OR_DUE + episode SCHEDULED → FIRED_OR_DUE', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 500, status: 'FIRED_OR_DUE' } });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const d = dirty();
    consumeDueScheduledClaim(transitions, scheduled, loadOwnershipRevisions(), 'med-1', 1000, d);

    expect(d.transitions).toBe(true);
    expect(d.scheduled).toBe(false); // record already consumed
    expect(transitions['med-1'].notificationState).toBe('FIRED_OR_DUE');
  });

  it('does nothing for a still-future bound claim (PENDING_FUTURE is not consumed)', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 5000, status: 'SCHEDULED' } });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const d = dirty();
    consumeDueScheduledClaim(transitions, scheduled, loadOwnershipRevisions(), 'med-1', 1000, d);

    expect(d.transitions).toBe(false);
    expect(d.scheduled).toBe(false);
    expect(transitions['med-1'].notificationState).toBe('SCHEDULED');
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
  });

  it('leaves a SENT episode alone (terminal ownership) and ignores unbound/other-key claims', () => {
    writeTransitions({
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SENT' },
      'med-2': { transitionKey: 'B', enteredAt: 1, notificationState: 'SCHEDULED' },
    });
    writeScheduled({
      'med-1': { transitionKey: 'A', alarmTime: 500, status: 'SCHEDULED' },
      'med-2': { transitionKey: 'OTHER', alarmTime: 500, status: 'SCHEDULED' },
    });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const d = dirty();
    consumeDueScheduledClaim(transitions, scheduled, loadOwnershipRevisions(), 'med-1', 1000, d);
    consumeDueScheduledClaim(transitions, scheduled, loadOwnershipRevisions(), 'med-2', 1000, d);

    expect(d.transitions).toBe(false);
    expect(d.scheduled).toBe(false);
    expect(transitions['med-1'].notificationState).toBe('SENT');
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(transitions['med-2'].notificationState).toBe('SCHEDULED');
    expect(scheduled['med-2'].status).toBe('SCHEDULED');
  });

  it('repeated consumption passes are idempotent (no duplicate revision bumps, no state flips)', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 500, status: 'SCHEDULED' } });
    writeOwnership({ 'med-1': 1 });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const revisions = loadOwnershipRevisions();
    const d1 = dirty();
    consumeDueScheduledClaim(transitions, scheduled, revisions, 'med-1', 1000, d1);
    const d2 = dirty();
    consumeDueScheduledClaim(transitions, scheduled, revisions, 'med-1', 1000, d2);
    const d3 = dirty();
    consumeDueScheduledClaim(transitions, scheduled, revisions, 'med-1', 2000, d3);

    expect(d2.transitions).toBe(false);
    expect(d2.scheduled).toBe(false);
    expect(d2.ownership).toBe(false);
    expect(d3.transitions).toBe(false);
    expect(d3.scheduled).toBe(false);
    expect(revisions['med-1']).toBe(2); // bumped exactly once
  });
});

describe('reconcileCriticalEpisode — foreground send consumes the bound claim (Path A)', () => {
  it('foreground send on an early crossing neutralizes the bound FUTURE claim (no SCHEDULED claim survives a SENT episode)', () => {
    const alarmTime = Date.now() + 86400000;
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' } });

    const { result, sent } = pass({ isCriticalish: true, canNotify: true });
    expect(sent).toBe(1);
    expect(result!.transition.notificationState).toBe('SENT');

    const rec = loadScheduledCriticalAlarms()['med-1'];
    // The claim was consumed by the foreground send: no valid SCHEDULED
    // claim survives for a SENT episode, so even if the scheduler never
    // runs again the armed alarm can never own/resurrect a notification.
    expect(rec.status).toBe('NOT_SCHEDULED');
    expect(rec.transitionKey).toBe(result!.transition.transitionKey);
    expect(rec.alarmTime).toBe(alarmTime);
  });

  it('foreground send neutralizes a MISMATCHED-BOUND SCHEDULED claim left over from a dead episode (no valid claim survives a SENT episode)', () => {
    // Pre-existing NONE episode (e.g. migrated legacy transition or a
    // crash between the owner's two store writes) plus an armed
    // SCHEDULED claim still bound to a DIFFERENT (dead) key. The
    // foreground consumes the episode's notification; the stale armed
    // claim must not survive — otherwise its native alarm could only
    // ever fire a SECOND user-facing notification for the SENT episode.
    const alarmTime = Date.now() + 86400000;
    writeTransitions({
      'med-1': { transitionKey: 'crit_med-1_LIVE', enteredAt: 1, notificationState: 'NONE' },
    });
    writeScheduled({
      'med-1': { transitionKey: 'crit_med-1_DEAD', alarmTime, status: 'SCHEDULED' },
    });

    const { result, sent } = pass({ isCriticalish: true, canNotify: true });
    expect(sent).toBe(1);
    expect(result!.transition.notificationState).toBe('SENT');
    expect(result!.transition.transitionKey).toBe('crit_med-1_LIVE');

    const rec = loadScheduledCriticalAlarms()['med-1'];
    expect(rec.status).toBe('NOT_SCHEDULED');
    // Binding is not the sender's to erase, but the claim is no longer
    // a valid SCHEDULED claim for ANY key.
    expect(rec.transitionKey).toBe('crit_med-1_DEAD');
    expect(rec.alarmTime).toBe(alarmTime);
  });

  it('foreground send neutralizes an UNBOUND SCHEDULED claim orphaned by a crash between the owner\u2019s writes', () => {
    // Episode persisted (NONE) but the bind write never landed: the
    // claim is still unbound (''). The armed alarm must not survive the
    // foreground consumption.
    const alarmTime = Date.now() + 86400000;
    writeTransitions({
      'med-1': { transitionKey: 'crit_med-1_LIVE', enteredAt: 1, notificationState: 'NONE' },
    });
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' } });

    const { result, sent } = pass({ isCriticalish: true, canNotify: true });
    expect(sent).toBe(1);
    expect(result!.transition.notificationState).toBe('SENT');

    const rec = loadScheduledCriticalAlarms()['med-1'];
    expect(rec.status).toBe('NOT_SCHEDULED');
    expect(rec.alarmTime).toBe(alarmTime);
  });

  it('a second reconcile pass after the foreground send keeps everything terminal (idempotent)', () => {
    writeScheduled({ 'med-1': { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'SCHEDULED' } });

    pass({ isCriticalish: true, canNotify: true });
    const firstState = loadScheduledCriticalAlarms()['med-1'];
    const transitionsBefore = loadCriticalTransitions()['med-1'];

    const second = pass({ isCriticalish: true, canNotify: true });
    expect(second.sent).toBe(0);
    expect(second.result!.transition.transitionKey).toBe(transitionsBefore.transitionKey);
    expect(second.result!.transition.notificationState).toBe('SENT');
    expect(loadScheduledCriticalAlarms()['med-1']).toEqual(firstState);
  });
});

describe('applyDeliveredCriticalEvidence — FIRED_OR_DUE + persisted evidence', () => {
  const alarmIdFor = (medId: string) => medId.length;

  it('upgrades a FIRED_OR_DUE episode to SENT with positive drawer evidence and marks the claim DELIVERED', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'FIRED_OR_DUE' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 500, status: 'FIRED_OR_DUE' } });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const revisions = loadOwnershipRevisions();
    const changed = applyDeliveredCriticalEvidence(['med-1'], new Set([alarmIdFor('med-1')]), transitions, scheduled, revisions, alarmIdFor);

    expect(changed).toBe(true);
    expect(transitions['med-1'].notificationState).toBe('SENT');
    expect(scheduled['med-1'].status).toBe('DELIVERED'); // evidence persisted
    expect(revisions['med-1']).toBe(1);
  });

  it('absence from the drawer never moves a FIRED_OR_DUE episode (delivery stays UNKNOWN, claim stays consumed)', () => {
    writeTransitions({ 'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'FIRED_OR_DUE' } });
    writeScheduled({ 'med-1': { transitionKey: 'A', alarmTime: 500, status: 'FIRED_OR_DUE' } });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const changed = applyDeliveredCriticalEvidence(['med-1'], new Set<number>(), transitions, scheduled, loadOwnershipRevisions(), alarmIdFor);

    expect(changed).toBe(false);
    expect(transitions['med-1'].notificationState).toBe('FIRED_OR_DUE');
    expect(scheduled['med-1'].status).toBe('FIRED_OR_DUE');
  });

  it('never touches NONE or SENT episodes', () => {
    writeTransitions({
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'NONE' },
      'med-2': { transitionKey: 'B', enteredAt: 1, notificationState: 'SENT' },
    });
    writeScheduled({
      'med-1': { transitionKey: 'A', alarmTime: 500, status: 'SCHEDULED' },
      'med-2': { transitionKey: 'B', alarmTime: 500, status: 'SCHEDULED' },
    });

    const transitions = loadCriticalTransitions();
    const scheduled = loadScheduledCriticalAlarms();
    const changed = applyDeliveredCriticalEvidence(
      ['med-1', 'med-2'],
      new Set([alarmIdFor('med-1'), alarmIdFor('med-2')]),
      transitions,
      scheduled,
      loadOwnershipRevisions(),
      alarmIdFor
    );

    expect(changed).toBe(false);
    expect(transitions['med-1'].notificationState).toBe('NONE');
    expect(transitions['med-2'].notificationState).toBe('SENT');
  });
});

describe('FIRED_OR_DUE storage normalization (migration-safe, single authoritative v2)', () => {
  it('loads a persisted FIRED_OR_DUE transition verbatim', () => {
    writeTransitions({ 'med-1': { transitionKey: 'k1', enteredAt: 7, notificationState: 'FIRED_OR_DUE' } });
    expect(loadCriticalTransitions()['med-1']).toEqual({
      transitionKey: 'k1',
      enteredAt: 7,
      notificationState: 'FIRED_OR_DUE',
    });
  });

  it('loads a persisted FIRED_OR_DUE scheduled record verbatim (shape unchanged, no version bump)', () => {
    writeScheduled({ 'med-1': { transitionKey: 'k1', alarmTime: 42, status: 'FIRED_OR_DUE' } });
    expect(loadScheduledCriticalAlarms()['med-1']).toEqual({
      transitionKey: 'k1',
      alarmTime: 42,
      status: 'FIRED_OR_DUE',
    });
  });

  it('normalizes an unknown status to the safe direction (registered alarm stays SCHEDULED)', () => {
    writeScheduled({
      'med-1': { transitionKey: '', alarmTime: 42, status: 'SOMETHING_NEW' },
      'med-2': { transitionKey: '', alarmTime: 0, status: 'SOMETHING_NEW' },
    } as unknown as Record<string, ScheduledCriticalAlarmRecord>);
    const loaded = loadScheduledCriticalAlarms();
    expect(loaded['med-1'].status).toBe('SCHEDULED');
    expect(loaded['med-2'].status).toBe('NOT_SCHEDULED');
  });
});

describe('updateScheduledAlarm — due-claim bound to the active transition is never re-armed', () => {
  it('refuses SCHEDULED(due) → SCHEDULED(future) for the SAME transition (the fired-while-dead re-arm guard)', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': {
        transitionKey: 'A',
        alarmTime: Date.now() - 3600000, // firing window already reached
        status: 'SCHEDULED',
        generation: 3,
      },
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' },
    };

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 999999, // the "now + 1s" resurrection attempt
        baselineGeneration: 3,
        now: Date.now(),
      })
    ).toBe('refused');
    // The due claim is untouched — the owner consumes it instead.
    expect(scheduled['med-1'].status).toBe('SCHEDULED');
    expect(scheduled['med-1'].alarmTime).toBe(Date.now() - 3600000);
  });

  it('still allows rescheduling a claim that is genuinely still PENDING (future) for the same transition', () => {
    const scheduled: Record<string, ScheduledCriticalAlarmRecord> = {
      'med-1': {
        transitionKey: 'A',
        alarmTime: Date.now() + 3600000, // still future
        status: 'SCHEDULED',
        generation: 3,
      },
    };
    const transitions: Record<string, CriticalTransitionState> = {
      'med-1': { transitionKey: 'A', enteredAt: 1, notificationState: 'SCHEDULED' },
    };

    expect(
      updateScheduledAlarm(scheduled, transitions, 'med-1', {
        alarmTime: Date.now() + 7200000,
        baselineGeneration: 3,
        now: Date.now(),
      })
    ).toBe('persisted');
    expect(scheduled['med-1'].alarmTime).toBe(Date.now() + 7200000);
    expect(scheduled['med-1'].transitionKey).toBe('A');
  });
});

describe('reconcileCriticalEpisode — dead-bound consumed leftovers (any status)', () => {
  it('a bound FIRED_OR_DUE leftover of a dead episode is neutralized — never inherited by a new episode', () => {
    writeScheduled({
      'med-1': { transitionKey: 'crit_med-1_DEAD_A', alarmTime: Date.now() - 3600000, status: 'FIRED_OR_DUE' },
    });

    const { result, sent } = pass({ isCriticalish: true, canNotify: true });
    // Fresh identity, foreground fires (the dead claim owns nothing).
    expect(sent).toBe(1);
    expect(result!.transition.notificationState).toBe('SENT');
    expect(result!.transition.transitionKey).not.toBe('crit_med-1_DEAD_A');
    const rec = loadScheduledCriticalAlarms()['med-1'];
    expect(rec.status).toBe('NOT_SCHEDULED');
    expect(rec.transitionKey).toBe('crit_med-1_DEAD_A'); // inert binding info only
  });

  it('a bound DELIVERED leftover of a dead episode is neutralized too', () => {
    writeScheduled({
      'med-1': { transitionKey: 'crit_med-1_DEAD_B', alarmTime: Date.now() - 3600000, status: 'DELIVERED' },
    });

    const { result, sent } = pass({ isCriticalish: true, canNotify: true });
    expect(sent).toBe(1);
    expect(result!.transition.notificationState).toBe('SENT');
    expect(loadScheduledCriticalAlarms()['med-1'].status).toBe('NOT_SCHEDULED');
  });
});
