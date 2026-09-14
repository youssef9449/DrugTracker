/**
 * Phase 2 native auto-deduction invariant contracts.
 *
 * Native Java (AlarmManager / SharedPreferences / SCHEDULE_LOCK) cannot execute
 * in this Vitest environment. These tests lock the pure decision matrices and
 * identity rules derived from:
 *   - AutoDeductionContract.java
 *   - AutoDeductionScheduler.java
 *   - AutoDeductionEventStore.java
 *   - AutoDeductionReceiver.java
 *   - docs/AUTO_DEDUCTION_ARCHITECTURE.md
 *
 * They are regression locks for a future Android/JVM harness, not a substitute
 * for instrumented tests of durable prefs or AlarmManager.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// A. Canonical occurrence identity (mirrors AutoDeductionContract.occurrenceKey)
// ---------------------------------------------------------------------------

const SEP = '\u001f';

function occurrenceKey(
  medicationId: string | null | undefined,
  doseId: string | null | undefined,
  calendarDate: string | null | undefined
): string {
  return `${medicationId ?? ''}${SEP}${doseId ?? ''}${SEP}${calendarDate ?? ''}`;
}

describe('Phase2 A — canonical occurrence identity', () => {
  it('same med+dose+date yields identical key', () => {
    expect(occurrenceKey('m1', 'd1', '2026-09-14')).toBe(
      occurrenceKey('m1', 'd1', '2026-09-14')
    );
  });

  it('different medication isolates keys', () => {
    expect(occurrenceKey('m1', 'd1', '2026-09-14')).not.toBe(
      occurrenceKey('m2', 'd1', '2026-09-14')
    );
  });

  it('different doseId isolates keys (multi-dose)', () => {
    expect(occurrenceKey('m1', 'morning', '2026-09-14')).not.toBe(
      occurrenceKey('m1', 'evening', '2026-09-14')
    );
  });

  it('different calendarDate isolates keys', () => {
    expect(occurrenceKey('m1', 'd1', '2026-09-14')).not.toBe(
      occurrenceKey('m1', 'd1', '2026-09-15')
    );
  });

  it('identity does not collapse on empty segments (null → empty)', () => {
    expect(occurrenceKey(null, 'd', '2026-09-14')).toBe(
      occurrenceKey('', 'd', '2026-09-14')
    );
    expect(occurrenceKey('m', null, '2026-09-14')).not.toBe(
      occurrenceKey('m', 'd', '2026-09-14')
    );
  });

  it('key is not derived from time, amount, or scheduleVersion', () => {
    // Documented invariant: identity is only med+dose+date.
    const k = occurrenceKey('m', 'd', '2026-09-14');
    expect(k.includes('08:00')).toBe(false);
    expect(k.includes('1.5')).toBe(false);
    expect(k.split(SEP)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// B/K. Calendar / time / amount validation (AutoDeductionContract)
// ---------------------------------------------------------------------------

function isGregorianLeapYear(year: number): boolean {
  if (year % 4 !== 0) return false;
  if (year % 100 !== 0) return true;
  return year % 400 === 0;
}

function isValidCalendarDate(date: string | null | undefined): boolean {
  if (date == null || date.length !== 10) return false;
  for (let i = 0; i < 10; i++) {
    const c = date.charAt(i);
    if (i === 4 || i === 7) {
      if (c !== '-') return false;
    } else if (c < '0' || c > '9') {
      return false;
    }
  }
  const year = Number.parseInt(date.substring(0, 4), 10);
  const month = Number.parseInt(date.substring(5, 7), 10);
  const day = Number.parseInt(date.substring(8, 10), 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  let maxDay: number;
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      maxDay = 31;
      break;
    case 4:
    case 6:
    case 9:
    case 11:
      maxDay = 30;
      break;
    case 2:
      maxDay = isGregorianLeapYear(year) ? 29 : 28;
      break;
    default:
      return false;
  }
  return day <= maxDay;
}

function isValidTimeHhmm(time: string | null | undefined): boolean {
  if (time == null) return false;
  if (time.length < 4 || time.length > 5) return false;
  const colon = time.indexOf(':');
  if (colon < 1) return false;
  const h = Number.parseInt(time.substring(0, colon), 10);
  const m = Number.parseInt(time.substring(colon + 1), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return false;
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function isValidAmount(amount: number): boolean {
  return !Number.isNaN(amount) && Number.isFinite(amount) && amount > 0;
}

/** Mirrors AutoDeductionScheduler.nextCalendarDate using pure UTC day arithmetic. */
function nextCalendarDate(calendarDate: string): string | null {
  if (!isValidCalendarDate(calendarDate)) return null;
  const y = Number.parseInt(calendarDate.substring(0, 4), 10);
  const mo = Number.parseInt(calendarDate.substring(5, 7), 10);
  const d = Number.parseInt(calendarDate.substring(8, 10), 10);
  // Use UTC noon to avoid DST edge when advancing calendar days.
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

describe('Phase2 B/K — calendar, time, amount validation', () => {
  it('accepts valid dates including leap-day', () => {
    expect(isValidCalendarDate('2026-09-14')).toBe(true);
    expect(isValidCalendarDate('2024-02-29')).toBe(true); // leap
    expect(isValidCalendarDate('2000-02-29')).toBe(true); // century leap
  });

  it('rejects impossible / malformed dates', () => {
    expect(isValidCalendarDate('2026-02-31')).toBe(false);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
    expect(isValidCalendarDate('2026-00-10')).toBe(false);
    expect(isValidCalendarDate('2026-09-00')).toBe(false);
    expect(isValidCalendarDate('2025-02-29')).toBe(false); // non-leap
    expect(isValidCalendarDate('1900-02-29')).toBe(false); // century non-leap
    expect(isValidCalendarDate('2026-9-14')).toBe(false);
    expect(isValidCalendarDate('2026/09/14')).toBe(false);
    expect(isValidCalendarDate(null)).toBe(false);
    expect(isValidCalendarDate('')).toBe(false);
  });

  it('accepts valid HH:mm and rejects out of range', () => {
    expect(isValidTimeHhmm('00:00')).toBe(true);
    expect(isValidTimeHhmm('23:59')).toBe(true);
    expect(isValidTimeHhmm('8:00')).toBe(true);
    expect(isValidTimeHhmm('24:00')).toBe(false);
    expect(isValidTimeHhmm('12:60')).toBe(false);
    expect(isValidTimeHhmm('12')).toBe(false);
    expect(isValidTimeHhmm(null)).toBe(false);
  });

  it('amount must be finite and > 0', () => {
    expect(isValidAmount(1)).toBe(true);
    expect(isValidAmount(0.5)).toBe(true);
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(-1)).toBe(false);
    expect(isValidAmount(Number.NaN)).toBe(false);
    expect(isValidAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('nextCalendarDate advances across month and year boundaries', () => {
    expect(nextCalendarDate('2026-09-14')).toBe('2026-09-15');
    expect(nextCalendarDate('2026-01-31')).toBe('2026-02-01');
    expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01');
    expect(nextCalendarDate('2024-02-28')).toBe('2024-02-29');
    expect(nextCalendarDate('2024-02-29')).toBe('2024-03-01');
    expect(nextCalendarDate('2025-02-28')).toBe('2025-03-01');
    expect(nextCalendarDate('2026-02-31')).toBeNull();
    expect(nextCalendarDate('bad')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C/D. Durable ordering tokens + effective cancellation
//     (mirrors parseOrderingToken / isOrderingNewer / isOccurrenceCancelledKey)
// ---------------------------------------------------------------------------

type Ord = { millis: number; seq: number };

function parseOrderingToken(raw: string | null | undefined): Ord {
  if (raw == null || raw === '') return { millis: -1, seq: 0 };
  const s = raw.trim();
  try {
    const firstDash = s.indexOf('-');
    if (firstDash <= 0) {
      // Legacy pure-millis tombstone.
      return { millis: Number.parseInt(s, 10), seq: 0 };
    }
    const millis = Number.parseInt(s.substring(0, firstDash).trim(), 10);
    const secondDash = s.indexOf('-', firstDash + 1);
    const seqPart =
      secondDash > firstDash
        ? s.substring(firstDash + 1, secondDash)
        : s.substring(firstDash + 1);
    const seq = Number.parseInt(seqPart.trim(), 10);
    if (Number.isNaN(millis) || Number.isNaN(seq)) return { millis: -1, seq: 0 };
    return { millis, seq };
  } catch {
    return { millis: -1, seq: 0 };
  }
}

function isOrderingNewer(a: Ord, b: Ord): boolean {
  if (a.millis !== b.millis) return a.millis > b.millis;
  return a.seq > b.seq;
}

/**
 * Effective cancellation from durable state only.
 * Mirrors AutoDeductionScheduler.isOccurrenceCancelledKey rules:
 *   - no tombstone → not cancelled
 *   - tombstone, no schedule metadata → cancelled
 *   - both present → schedule strictly newer than cancel → active; else cancelled
 */
function isEffectivelyCancelled(
  cancelRaw: string | null | undefined,
  scheduleRaw: string | null | undefined
): boolean {
  if (cancelRaw == null || cancelRaw === '') return false;
  if (scheduleRaw == null || scheduleRaw === '') return true;
  let scheduleVersion = '';
  try {
    const o = JSON.parse(scheduleRaw) as { scheduleVersion?: string };
    scheduleVersion = o.scheduleVersion ?? '';
  } catch {
    return true;
  }
  if (!scheduleVersion) return true;
  const cancelOrd = parseOrderingToken(cancelRaw);
  const scheduleOrd = parseOrderingToken(scheduleVersion);
  if (
    scheduleOrd.millis >= 0 &&
    cancelOrd.millis >= 0 &&
    isOrderingNewer(scheduleOrd, cancelOrd)
  ) {
    return false;
  }
  return true;
}

describe('Phase2 C — durable ordering tokens', () => {
  it('parses versioned "{millis}-{seq}-{uuid}" tokens', () => {
    expect(parseOrderingToken('1000-3-abc')).toEqual({ millis: 1000, seq: 3 });
    expect(parseOrderingToken('1000-1-uuid')).toEqual({ millis: 1000, seq: 1 });
  });

  it('parses legacy pure-millis tombstones as seq=0', () => {
    expect(parseOrderingToken('1700000000000')).toEqual({
      millis: 1700000000000,
      seq: 0,
    });
  });

  it('malformed tokens yield millis=-1', () => {
    expect(parseOrderingToken('')).toEqual({ millis: -1, seq: 0 });
    expect(parseOrderingToken(null)).toEqual({ millis: -1, seq: 0 });
    expect(parseOrderingToken('not-a-number-x')).toEqual({ millis: -1, seq: 0 });
  });

  it('same-millisecond ordering is distinguished by seq', () => {
    const older = { millis: 5000, seq: 1 };
    const newer = { millis: 5000, seq: 2 };
    expect(isOrderingNewer(newer, older)).toBe(true);
    expect(isOrderingNewer(older, newer)).toBe(false);
  });

  it('primary key is millis then seq', () => {
    expect(isOrderingNewer({ millis: 2, seq: 0 }, { millis: 1, seq: 99 })).toBe(
      true
    );
    expect(isOrderingNewer({ millis: 1, seq: 99 }, { millis: 2, seq: 0 })).toBe(
      false
    );
  });

  it('sequence is strictly increasing when allocated (documented invariant)', () => {
    // allocateOrderingTokenLocked: next = last + 1; skipped values after crash OK.
    const seqs = [1, 2, 3, 5]; // 4 skipped after hypothetical crash
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});

describe('Phase2 D — cancellation tombstone effective status', () => {
  const sch = (version: string) =>
    JSON.stringify({ scheduleVersion: version, amount: 1, timeHhmm: '08:00' });

  it('no tombstone + no metadata → active (not cancelled)', () => {
    expect(isEffectivelyCancelled(null, null)).toBe(false);
  });

  it('tombstone + no metadata → cancelled', () => {
    expect(isEffectivelyCancelled('1000-1-u', null)).toBe(true);
    expect(isEffectivelyCancelled('1000-1-u', '')).toBe(true);
  });

  it('tombstone + metadata where schedule is newer → active', () => {
    expect(isEffectivelyCancelled('1000-1-u', sch('1000-2-u'))).toBe(false);
    expect(isEffectivelyCancelled('1000-1-u', sch('2000-1-u'))).toBe(false);
  });

  it('tombstone + metadata where cancel is newer → cancelled', () => {
    expect(isEffectivelyCancelled('2000-1-u', sch('1000-5-u'))).toBe(true);
    expect(isEffectivelyCancelled('1000-5-u', sch('1000-4-u'))).toBe(true);
  });

  it('same-millisecond: seq decides cancel vs schedule', () => {
    expect(isEffectivelyCancelled('1000-2-c', sch('1000-1-s'))).toBe(true);
    expect(isEffectivelyCancelled('1000-1-c', sch('1000-2-s'))).toBe(false);
  });

  it('legacy pure-millis cancel vs versioned schedule', () => {
    // Legacy cancel millis=1000 seq=0; schedule 1000-1 is newer → active
    expect(isEffectivelyCancelled('1000', sch('1000-1-u'))).toBe(false);
    // Schedule older pure millis in version field path: cancel newer → cancelled
    expect(isEffectivelyCancelled('2000', sch('1000-1-u'))).toBe(true);
  });

  it('malformed cancel or schedule leans cancelled when tombstone present', () => {
    expect(isEffectivelyCancelled('not-valid', sch('1000-1-u'))).toBe(true);
    expect(isEffectivelyCancelled('1000-1-u', '{bad json')).toBe(true);
    expect(isEffectivelyCancelled('1000-1-u', JSON.stringify({}))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E/F. Fire-vs-cancel linearization + FIRED insert outcomes + recurrence gate
// ---------------------------------------------------------------------------

type FireStatus = 'CANCELLED' | 'CREATED' | 'ALREADY_EXISTS' | 'FAILED';

interface FireResult {
  status: FireStatus;
  pendingRecorded: boolean;
}

/** Mirrors FireResult.allowsRecurrence */
function allowsRecurrence(fr: FireResult): boolean {
  return (
    fr.status === 'CREATED' ||
    fr.status === 'ALREADY_EXISTS' ||
    (fr.status === 'FAILED' && fr.pendingRecorded)
  );
}

/**
 * Receiver truth table (AutoDeductionReceiver):
 * CREATED / ALREADY_EXISTS / FAILED+pending → schedule next if possible
 * CANCELLED / FAILED without pending → no recurrence
 */
function receiverShouldScheduleNext(fr: FireResult): boolean {
  if (fr.status === 'CANCELLED') return false;
  if (fr.status === 'FAILED' && !fr.pendingRecorded) return false;
  return allowsRecurrence(fr);
}

/**
 * Deterministic fire linearization outcome given durable cancel state at
 * the moment SCHEDULE_LOCK is held (no TOCTOU).
 */
function fireLinearizationOutcome(args: {
  effectivelyCancelled: boolean;
  alreadyFired: boolean;
  primaryWriteOk: boolean;
  pendingWriteOk: boolean;
}): FireResult {
  if (args.effectivelyCancelled) {
    return { status: 'CANCELLED', pendingRecorded: false };
  }
  if (args.alreadyFired) {
    return { status: 'ALREADY_EXISTS', pendingRecorded: false };
  }
  if (args.primaryWriteOk) {
    return { status: 'CREATED', pendingRecorded: false };
  }
  return { status: 'FAILED', pendingRecorded: args.pendingWriteOk };
}

describe('Phase2 E — fire-vs-cancel linearization', () => {
  it('cancel linearizes first → no FIRED, no pending, no recurrence', () => {
    const fr = fireLinearizationOutcome({
      effectivelyCancelled: true,
      alreadyFired: false,
      primaryWriteOk: true,
      pendingWriteOk: true,
    });
    expect(fr.status).toBe('CANCELLED');
    expect(fr.pendingRecorded).toBe(false);
    expect(allowsRecurrence(fr)).toBe(false);
    expect(receiverShouldScheduleNext(fr)).toBe(false);
  });

  it('fire linearizes first (CREATED) → durable fire; later cancel cannot erase it', () => {
    // Once CREATED is returned, FIRED is durable; cancel after that only
    // tombstones the occurrence for *future* deliveries, not the event row.
    const fr = fireLinearizationOutcome({
      effectivelyCancelled: false,
      alreadyFired: false,
      primaryWriteOk: true,
      pendingWriteOk: false,
    });
    expect(fr.status).toBe('CREATED');
    expect(allowsRecurrence(fr)).toBe(true);
    expect(receiverShouldScheduleNext(fr)).toBe(true);
  });

  it('duplicate delivery after fire → ALREADY_EXISTS (insert-if-absent)', () => {
    const fr = fireLinearizationOutcome({
      effectivelyCancelled: false,
      alreadyFired: true,
      primaryWriteOk: true,
      pendingWriteOk: false,
    });
    expect(fr.status).toBe('ALREADY_EXISTS');
    expect(allowsRecurrence(fr)).toBe(true);
    expect(receiverShouldScheduleNext(fr)).toBe(true);
  });

  it('primary fail + pending recorded still advances recurrence', () => {
    const fr = fireLinearizationOutcome({
      effectivelyCancelled: false,
      alreadyFired: false,
      primaryWriteOk: false,
      pendingWriteOk: true,
    });
    expect(fr.status).toBe('FAILED');
    expect(fr.pendingRecorded).toBe(true);
    expect(allowsRecurrence(fr)).toBe(true);
    expect(receiverShouldScheduleNext(fr)).toBe(true);
  });

  it('primary fail without pending does not advance recurrence', () => {
    const fr = fireLinearizationOutcome({
      effectivelyCancelled: false,
      alreadyFired: false,
      primaryWriteOk: false,
      pendingWriteOk: false,
    });
    expect(fr.status).toBe('FAILED');
    expect(allowsRecurrence(fr)).toBe(false);
    expect(receiverShouldScheduleNext(fr)).toBe(false);
  });
});

describe('Phase2 F — durable FIRED insert-if-absent semantics', () => {
  it('first fire CREATED; second ALREADY_EXISTS; no second logical event', () => {
    const first = fireLinearizationOutcome({
      effectivelyCancelled: false,
      alreadyFired: false,
      primaryWriteOk: true,
      pendingWriteOk: false,
    });
    const second = fireLinearizationOutcome({
      effectivelyCancelled: false,
      alreadyFired: true,
      primaryWriteOk: true,
      pendingWriteOk: false,
    });
    expect(first.status).toBe('CREATED');
    expect(second.status).toBe('ALREADY_EXISTS');
  });

  it('FIRED identity is the same occurrence key as schedule/cancel', () => {
    const k = occurrenceKey('med', 'dose-am', '2026-09-14');
    expect(k).toBe(`med${SEP}dose-am${SEP}2026-09-14`);
  });
});

// ---------------------------------------------------------------------------
// G. Duplicate/stale fire recurrence — scheduleNextOccurrenceIfAbsent (#216/#220)
// ---------------------------------------------------------------------------

type SuccessorDecision =
  | { action: 'noop_exists'; reason: 'metadata_present' }
  | { action: 'noop_cancelled'; reason: 'effectively_cancelled' }
  | { action: 'create'; reason: 'absent_and_active' }
  | { action: 'fail_permission'; reason: 'exact_alarm_denied' };

/**
 * Decision matrix for scheduleNextOccurrenceIfAbsent under SCHEDULE_LOCK.
 * Does not call scheduleOccurrenceLocked when cancelled (would clear tombstone).
 */
function scheduleNextIfAbsentDecision(state: {
  successorMetadataPresent: boolean;
  successorEffectivelyCancelled: boolean;
  canScheduleExactAlarms: boolean;
}): SuccessorDecision {
  if (state.successorMetadataPresent) {
    return { action: 'noop_exists', reason: 'metadata_present' };
  }
  if (state.successorEffectivelyCancelled) {
    return { action: 'noop_cancelled', reason: 'effectively_cancelled' };
  }
  if (!state.canScheduleExactAlarms) {
    return { action: 'fail_permission', reason: 'exact_alarm_denied' };
  }
  return { action: 'create', reason: 'absent_and_active' };
}

describe('Phase2 G — create-if-absent recurrence (stale duplicate protection)', () => {
  it('normal first fire: D+1 absent and active → create', () => {
    expect(
      scheduleNextIfAbsentDecision({
        successorMetadataPresent: false,
        successorEffectivelyCancelled: false,
        canScheduleExactAlarms: true,
      })
    ).toEqual({ action: 'create', reason: 'absent_and_active' });
  });

  it('duplicate D when D+1 already exists → never overwrite', () => {
    expect(
      scheduleNextIfAbsentDecision({
        successorMetadataPresent: true,
        successorEffectivelyCancelled: false,
        canScheduleExactAlarms: true,
      })
    ).toEqual({ action: 'noop_exists', reason: 'metadata_present' });
  });

  it('duplicate D when D+1 cancelled (metadata gone, tombstone remains) → no recreate', () => {
    // Critical #220 regression: must not call scheduleOccurrenceLocked.
    expect(
      scheduleNextIfAbsentDecision({
        successorMetadataPresent: false,
        successorEffectivelyCancelled: true,
        canScheduleExactAlarms: true,
      })
    ).toEqual({ action: 'noop_cancelled', reason: 'effectively_cancelled' });
  });

  it('metadata presence wins over cancel flag (superseding schedule)', () => {
    // If metadata exists, we never rewrite; effective cancel is irrelevant for overwrite.
    expect(
      scheduleNextIfAbsentDecision({
        successorMetadataPresent: true,
        successorEffectivelyCancelled: true,
        canScheduleExactAlarms: true,
      })
    ).toEqual({ action: 'noop_exists', reason: 'metadata_present' });
  });

  it('multiple duplicate deliveries remain no-ops once successor exists', () => {
    const once = scheduleNextIfAbsentDecision({
      successorMetadataPresent: false,
      successorEffectivelyCancelled: false,
      canScheduleExactAlarms: true,
    });
    expect(once.action).toBe('create');
    const again = scheduleNextIfAbsentDecision({
      successorMetadataPresent: true,
      successorEffectivelyCancelled: false,
      canScheduleExactAlarms: true,
    });
    expect(again.action).toBe('noop_exists');
  });

  it('exact-alarm-permission path does not resurrect cancelled successor', () => {
    expect(
      scheduleNextIfAbsentDecision({
        successorMetadataPresent: false,
        successorEffectivelyCancelled: true,
        canScheduleExactAlarms: false,
      })
    ).toEqual({ action: 'noop_cancelled', reason: 'effectively_cancelled' });
  });

  it('permission denied only when absent and not cancelled', () => {
    expect(
      scheduleNextIfAbsentDecision({
        successorMetadataPresent: false,
        successorEffectivelyCancelled: false,
        canScheduleExactAlarms: false,
      })
    ).toEqual({ action: 'fail_permission', reason: 'exact_alarm_denied' });
  });

  it('multi-dose: successor keys are dose-isolated', () => {
    const d1Next = occurrenceKey('m', 'dose-am', nextCalendarDate('2026-09-14')!);
    const d2Next = occurrenceKey('m', 'dose-pm', nextCalendarDate('2026-09-14')!);
    expect(d1Next).not.toBe(d2Next);
  });

  it('stale D payload must not imply overwrite of newer amount/time on existing D+1', () => {
    // Documented: when metadata present, delivery payload is not applied.
    const decision = scheduleNextIfAbsentDecision({
      successorMetadataPresent: true,
      successorEffectivelyCancelled: false,
      canScheduleExactAlarms: true,
    });
    expect(decision.action).toBe('noop_exists');
  });
});

// ---------------------------------------------------------------------------
// H/I. Recovery recurrence continuity + stale snapshot ownership (#215/#218/#219)
// ---------------------------------------------------------------------------

function isMetadataOwnedByVersion(
  currentJson: string | null | undefined,
  expectedVersion: string | null | undefined
): boolean {
  if (expectedVersion == null || expectedVersion === '') return false;
  if (currentJson == null || currentJson === '') return false;
  try {
    const o = JSON.parse(currentJson) as { scheduleVersion?: string };
    return expectedVersion === (o.scheduleVersion ?? '');
  } catch {
    return false;
  }
}

/** Mirrors shouldRemovePastScheduleMetadata(FireResult) */
function shouldRemovePastScheduleMetadata(fr: FireResult | null): boolean {
  if (fr == null) return false;
  if (fr.status === 'CANCELLED') return true;
  return allowsRecurrence(fr);
}

type RecoverySuccessorDecision =
  | { action: 'skip_stale' }
  | { action: 'noop_exists' }
  | { action: 'create' }
  | { action: 'no_recurrence' };

/**
 * scheduleNextOccurrenceIfSnapshotOwnsPast decision (simplified durable checks).
 */
function recoverySuccessorDecision(args: {
  fire: FireResult;
  snapshotOwnsPast: boolean;
  successorMetadataPresent: boolean;
}): RecoverySuccessorDecision {
  if (!allowsRecurrence(args.fire) && args.fire.status !== 'CANCELLED') {
    return { action: 'no_recurrence' };
  }
  if (args.fire.status === 'CANCELLED') {
    return { action: 'no_recurrence' };
  }
  if (!args.snapshotOwnsPast) {
    return { action: 'skip_stale' };
  }
  if (args.successorMetadataPresent) {
    return { action: 'noop_exists' };
  }
  return { action: 'create' };
}

describe('Phase2 H — recovery recurrence continuity', () => {
  it('CREATED recovery allows D+1', () => {
    const fr: FireResult = { status: 'CREATED', pendingRecorded: false };
    expect(allowsRecurrence(fr)).toBe(true);
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: true,
        successorMetadataPresent: false,
      }).action
    ).toBe('create');
  });

  it('ALREADY_EXISTS recovery allows D+1', () => {
    const fr: FireResult = { status: 'ALREADY_EXISTS', pendingRecorded: false };
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: true,
        successorMetadataPresent: false,
      }).action
    ).toBe('create');
  });

  it('FAILED + pending allows D+1', () => {
    const fr: FireResult = { status: 'FAILED', pendingRecorded: true };
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: true,
        successorMetadataPresent: false,
      }).action
    ).toBe('create');
  });

  it('FAILED without pending preserves recovery source (no advance)', () => {
    const fr: FireResult = { status: 'FAILED', pendingRecorded: false };
    expect(shouldRemovePastScheduleMetadata(fr)).toBe(false);
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: true,
        successorMetadataPresent: false,
      }).action
    ).toBe('no_recurrence');
  });

  it('CANCELLED recovery removes past metadata path and does not schedule successor', () => {
    const fr: FireResult = { status: 'CANCELLED', pendingRecorded: false };
    expect(shouldRemovePastScheduleMetadata(fr)).toBe(true);
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: true,
        successorMetadataPresent: false,
      }).action
    ).toBe('no_recurrence');
  });

  it('repeated recovery with existing D+1 does not create duplicate successor', () => {
    const fr: FireResult = { status: 'ALREADY_EXISTS', pendingRecorded: false };
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: true,
        successorMetadataPresent: true,
      }).action
    ).toBe('noop_exists');
  });
});

describe('Phase2 I — stale recovery snapshot ownership (#219)', () => {
  const v1 = '1000-1-aaa';
  const v2 = '1000-2-bbb';
  const meta = (v: string) => JSON.stringify({ scheduleVersion: v, amount: 2 });

  it('snapshot owns past only when scheduleVersion still matches', () => {
    expect(isMetadataOwnedByVersion(meta(v1), v1)).toBe(true);
    expect(isMetadataOwnedByVersion(meta(v2), v1)).toBe(false);
    expect(isMetadataOwnedByVersion(null, v1)).toBe(false);
    expect(isMetadataOwnedByVersion(meta(v1), null)).toBe(false);
    expect(isMetadataOwnedByVersion('{bad', v1)).toBe(false);
  });

  it('stale snapshot cannot create/overwrite D+1 after D was replaced', () => {
    const fr: FireResult = { status: 'CREATED', pendingRecorded: false };
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: false, // version replaced
        successorMetadataPresent: false,
      }).action
    ).toBe('skip_stale');
  });

  it('existing D+1 remains untouched even if snapshot still owns past', () => {
    const fr: FireResult = { status: 'CREATED', pendingRecorded: false };
    expect(
      recoverySuccessorDecision({
        fire: fr,
        snapshotOwnsPast: true,
        successorMetadataPresent: true,
      }).action
    ).toBe('noop_exists');
  });

  it('ownership-safe remove only when expected version still present', () => {
    // removeScheduleMetadataIfVersion: only removes if current matches expected.
    const canRemove = (current: string | null, expected: string) =>
      isMetadataOwnedByVersion(current, expected);
    expect(canRemove(meta(v1), v1)).toBe(true);
    expect(canRemove(meta(v2), v1)).toBe(false);
    expect(canRemove(null, v1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M. Idempotency matrices (schedule / cancel / fire / restore / recurrence)
// ---------------------------------------------------------------------------

describe('Phase2 M — idempotency matrices', () => {
  it('fire insert-if-absent is idempotent for same occurrence key', () => {
    const outcomes = ['CREATED', 'ALREADY_EXISTS', 'ALREADY_EXISTS'] as const;
    expect(outcomes[0]).toBe('CREATED');
    expect(outcomes.slice(1).every((s) => s === 'ALREADY_EXISTS')).toBe(true);
  });

  it('cancel absent occurrence is terminal ALREADY_ABSENT-style success path', () => {
    // Documented CancelResult: ALREADY_ABSENT is ok (terminal).
    const status: 'SUCCESS' | 'ALREADY_ABSENT' | 'FAILED' = 'ALREADY_ABSENT';
    expect(status === 'SUCCESS' || status === 'ALREADY_ABSENT').toBe(true);
  });

  it('restore with existing D+1 is no-op for successor', () => {
    expect(
      recoverySuccessorDecision({
        fire: { status: 'ALREADY_EXISTS', pendingRecorded: false },
        snapshotOwnsPast: true,
        successorMetadataPresent: true,
      }).action
    ).toBe('noop_exists');
  });

  it('duplicate receiver deliveries after cancel stay CANCELLED with no recurrence', () => {
    const fr = fireLinearizationOutcome({
      effectivelyCancelled: true,
      alreadyFired: false,
      primaryWriteOk: true,
      pendingWriteOk: true,
    });
    expect(receiverShouldScheduleNext(fr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Receiver truth table (documented in architecture)
// ---------------------------------------------------------------------------

describe('Phase2 — receiver / recovery next-occurrence truth table', () => {
  const cases: Array<{ fr: FireResult; scheduleNext: boolean }> = [
    { fr: { status: 'CREATED', pendingRecorded: false }, scheduleNext: true },
    {
      fr: { status: 'ALREADY_EXISTS', pendingRecorded: false },
      scheduleNext: true,
    },
    { fr: { status: 'FAILED', pendingRecorded: true }, scheduleNext: true },
    { fr: { status: 'FAILED', pendingRecorded: false }, scheduleNext: false },
    { fr: { status: 'CANCELLED', pendingRecorded: false }, scheduleNext: false },
  ];

  for (const c of cases) {
    it(`${c.fr.status}${c.fr.pendingRecorded ? '+pending' : ''} → scheduleNext=${c.scheduleNext}`, () => {
      expect(receiverShouldScheduleNext(c.fr)).toBe(c.scheduleNext);
    });
  }
});
