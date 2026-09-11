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
    };
    saveScheduledCriticalAlarms(scheduled);
    expect(loadScheduledCriticalAlarms()).toEqual(scheduled);
  });
});
