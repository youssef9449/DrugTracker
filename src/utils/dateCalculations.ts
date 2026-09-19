import { Medication, getCriticalThresholdDays } from '../types';
import { MS_PER_DAY, NEVER_DEPLETES_DAYS, CRITICAL_ALARM_FIRE_HOUR, timeToMinutes } from './time';

/**
 * Returns today's date as a deterministic YYYY-MM-DD string, using
 * the client's local timezone.
 *
 * This is a client-side Vite SPA (no SSR), so there is no server/client
 * hydration concern. The function is kept pure (no window/localStorage
 * access) simply so it can be safely called during module init and
 * from the seed-data file without side effects.
 */
export function getTodayDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse a "YYYY-MM-DD" string into a UTC midnight Date.
 *
 * Why UTC: `new Date(2024, m, d)` interprets the components in the
 * LOCAL timezone, and `setDate`/`getTime` math then crosses DST
 * boundaries with 23- or 25-hour days — producing off-by-one errors
 * around DST transitions. Treating YYYY-MM-DD as a UTC calendar date
 * makes day arithmetic exact (1 day = 86400000 ms, always).
 */
function parseUtcDate(dateStr: string): Date | null {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  // Date.UTC month is 0-indexed.
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date (interpreted as UTC) back to "YYYY-MM-DD". */
function formatUtcDateString(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Format a Date's LOCAL calendar date as a "YYYY-MM-DD" string. Used
 * to derive "today" from an explicit `now` (the dynamic-projection
 * callers accept an optional `now` for testability).
 */
function localDateStr(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Add `n` days to a YYYY-MM-DD string (UTC day arithmetic, DST-safe).
 * Used to compute "yesterday" for the settlement lastSyncDate rule:
 * a reminderTime-gated mutation that does NOT settle today's dose
 * advances lastSyncDate to yesterday so today's dose stays projectable
 * (and is settled at the next existing execution point — a later
 * mutation such as refill/consume/dose-change/toggle). The projection
 * (effectiveCurrentPills) reflects today's dose across the
 * calendar-day boundary without settling the snapshot.
 */
function addDaysToDateStr(dateStr: string, n: number): string {
  const d = parseUtcDate(dateStr);
  if (!d) return dateStr;
  return formatUtcDateString(new Date(d.getTime() + n * MS_PER_DAY));
}

/**
 * Whether the med's auto-deduction timing is gated by `reminderTime`.
 *
 * True iff reminders are enabled AND `reminderTime` is a valid "HH:MM"
 * string. When true, a day's dose becomes due at `reminderTime` on
 * that calendar day (local time). When false, auto-deduction uses the
 * legacy calendar-day behavior (a day's dose is due at the start of
 * the calendar day) — disabling the notification does NOT disable
 * auto-deduction, it only reverts the timing to the calendar-day
 * schedule.
 */
function isReminderTimeGated(med: Medication): boolean {
  return (
    med.reminderEnabled === true &&
    typeof med.reminderTime === 'string' &&
    timeToMinutes(med.reminderTime) >= 0
  );
}

/** Minutes-since-midnight (local) of `now`. */
function nowMinutesLocal(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** True when the med has a non-empty multi-dose schedule (Phase 1+). */
export function hasDoseSchedule(med: Medication): boolean {
  return Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0;
}

/**
 * Dates on which `doseId` was manually consumed.
 *
 * Prefers {@link Medication.doseConsumptionHistory}. When history is
 * absent (pre-Phase-3B data), falls back to
 * {@link Medication.doseConsumption} as a **single** known date — not a
 * reconstructed multi-day ledger. Overwritten last-dates from the old
 * model cannot be recovered and are never invented here.
 */
export function getDoseConsumedDates(med: Medication, doseId: string): string[] {
  const hist = med.doseConsumptionHistory?.[doseId];
  if (Array.isArray(hist) && hist.length > 0) {
    // Deduplicate while preserving order
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of hist) {
      if (typeof d === 'string' && d && !seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
    return out;
  }
  const last = med.doseConsumption?.[doseId];
  return typeof last === 'string' && last ? [last] : [];
}

/**
 * Whether a specific dose slot was manually consumed on `dateStr`.
 * Multi-dose: true when history (or pre-3B last-date fallback) includes
 * that exact date. Legacy (no schedule): lastConsumedDate === dateStr.
 */
export function isDoseConsumedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): boolean {
  if (getDoseConsumedDates(med, doseId).includes(dateStr)) {
    return true;
  }
  if (!hasDoseSchedule(med) && med.lastConsumedDate === dateStr) {
    return true;
  }
  return false;
}

/**
 * Record a manual consumption of `doseId` on `dateStr`.
 * Updates last-date map (`doseConsumption`) and append-only history
 * (`doseConsumptionHistory`, no duplicate dates). Seeds history from
 * any pre-existing last-date entries so first post-upgrade consume does
 * not drop the one known pre-3B date.
 */
export function recordDoseConsumed(
  med: Medication,
  doseId: string,
  dateStr: string
): {
  doseConsumption: Record<string, string>;
  doseConsumptionHistory: Record<string, string[]>;
} {
  const doseConsumption: Record<string, string> = {
    ...(med.doseConsumption ?? {}),
    [doseId]: dateStr,
  };
  const doseConsumptionHistory: Record<string, string[]> = {
    ...(med.doseConsumptionHistory ?? {}),
  };
  // Seed history from any pre-existing last-date entries not yet in history
  for (const [id, last] of Object.entries(med.doseConsumption ?? {})) {
    if (!doseConsumptionHistory[id]?.length && last) {
      doseConsumptionHistory[id] = [last];
    }
  }
  const prev = doseConsumptionHistory[doseId] ?? [];
  if (!prev.includes(dateStr)) {
    doseConsumptionHistory[doseId] = [...prev, dateStr];
  } else {
    doseConsumptionHistory[doseId] = prev;
  }
  return { doseConsumption, doseConsumptionHistory };
}

/**
 * Whether a specific dose slot was restored/skipped on `dateStr`
 * (Auto-Deduct → Restore bookkeeping). Skipped slots are not auto-due
 * again for that date and are available for a later manual Take.
 */
export function isDoseSkippedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): boolean {
  const hist = med.doseSkippedHistory?.[doseId];
  return Array.isArray(hist) && hist.includes(dateStr);
}

/**
 * Record that `doseId` was restored/skipped on `dateStr` so auto-sync
 * and projection will not re-deduct that slot for that date.
 * Idempotent per doseId+date.
 */
export function recordDoseSkipped(
  med: Medication,
  doseId: string,
  dateStr: string
): { doseSkippedHistory: Record<string, string[]> } {
  const doseSkippedHistory: Record<string, string[]> = {
    ...(med.doseSkippedHistory ?? {}),
  };
  const prev = doseSkippedHistory[doseId] ?? [];
  if (!prev.includes(dateStr)) {
    doseSkippedHistory[doseId] = [...prev, dateStr];
  } else {
    doseSkippedHistory[doseId] = prev;
  }
  return { doseSkippedHistory };
}

/**
 * Clear a skip mark for `doseId` on `dateStr` (e.g. after manual Take
 * following Restore). Does not touch other dates or doseIds.
 */
export function clearDoseSkippedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): { doseSkippedHistory: Record<string, string[]> } {
  const doseSkippedHistory: Record<string, string[]> = {
    ...(med.doseSkippedHistory ?? {}),
  };
  const prev = doseSkippedHistory[doseId] ?? [];
  const next = prev.filter((d) => d !== dateStr);
  if (next.length === 0) {
    delete doseSkippedHistory[doseId];
  } else {
    doseSkippedHistory[doseId] = next;
  }
  return { doseSkippedHistory };
}


/**
 * Units still auto-due on a single historical calendar day (all slots
 * that day are fully elapsed).
 *
 * Known history: slots with a recorded consume/skip on `dateStr` are
 * skipped (already settled by Manual Take, Exact Auto apply, or skip —
 * never double-deducted).
 *
 * Unknown history (Phase 7 / D7-3): when no recorded consumption exists
 * for a slot on that date, the implementation cannot reconstruct the
 * historical amount if the user later edited the schedule. It therefore
 * uses the **current** schedule amount for that unrecorded slot
 * (deterministic full-schedule fallback). This is **not** historical
 * reconstruction of past amounts/times.
 *
 * Exact Auto does **not** rely on this fallback for fired occurrences:
 * `applyExactAutoEventToMedication` charges `event.amount` from the
 * durable FIRED payload. This helper only feeds legacy catch-up /
 * projection due math for slots without consume/skip markers.
 *
 * Phase 7 does not add historical schedule snapshots or schema changes.
 * This limitation is not Exact-vs-legacy double deduction.
 */
export function historicalDayDueUnits(med: Medication, dateStr: string): number {
  if (!hasDoseSchedule(med) || !med.doseSchedule) {
    return Number(med.dailyDose) || 0;
  }
  let units = 0;
  for (const d of med.doseSchedule) {
    const amount = Number(d.amount) || 0;
    if (amount <= 0) continue;
    if (isDoseConsumedOnDate(med, d.id, dateStr)) continue;
    if (isDoseSkippedOnDate(med, d.id, dateStr)) continue;
    units += amount;
  }
  return units;
}

/**
 * Sum of {@link historicalDayDueUnits} for each calendar day strictly
 * after `fromDateExclusive` and strictly before `toDateExclusive`
 * (the betweenDays window used by gated settlement). Each day is
 * settled independently so consecutive partially-consumed days do not
 * collapse into one incorrect aggregate.
 */
export function historicalRangeDueUnits(
  med: Medication,
  fromDateExclusive: string,
  toDateExclusive: string
): number {
  const days = getDaysDifference(fromDateExclusive, toDateExclusive);
  if (days <= 1) return 0; // no fully-elapsed day between
  let units = 0;
  // Walk from day after fromDate through day before toDate
  for (let i = 1; i < days; i++) {
    const day = addDaysToDateStr(fromDateExclusive, i);
    units += historicalDayDueUnits(med, day);
  }
  return units;
}

/** Sum of per-dose amounts, or dailyDose for legacy. */
export function dailyScheduleAmount(med: Medication): number {
  if (hasDoseSchedule(med)) {
    return med.doseSchedule!.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  }
  return Number(med.dailyDose) || 0;
}

/**
 * Units of stock that are due TODAY from the schedule (local time),
 * excluding slots already manually consumed today.
 */
export function todayDueUnits(
  med: Medication,
  now: Date,
  todayStr: string
): number {
  if (med.autoDeductEnabled === false) return 0;
  if (localDateStr(now) !== todayStr) return 0;

  if (hasDoseSchedule(med)) {
    const nowMin = nowMinutesLocal(now);
    let units = 0;
    for (const d of med.doseSchedule!) {
      const amount = Number(d.amount) || 0;
      if (amount <= 0) continue;
      const tMin = timeToMinutes(d.time);
      if (tMin < 0) continue;
      if (nowMin < tMin) continue;
      if (isDoseConsumedOnDate(med, d.id, todayStr)) continue;
      if (isDoseSkippedOnDate(med, d.id, todayStr)) continue;
      units += amount;
    }
    return units;
  }

  // Legacy single dose
  if (med.dailyDose <= 0) return 0;
  if (med.lastConsumedDate === todayStr) return 0;
  if (isReminderTimeGated(med)) {
    const reminderMin = timeToMinutes(med.reminderTime as string);
    return nowMinutesLocal(now) >= reminderMin ? med.dailyDose : 0;
  }
  // Non-gated legacy: today's dose is due at start of calendar day —
  // but only if lastSyncDate is before today (handled by caller via
  // totalDays). This helper only answers "is today's slot time-due?".
  return med.dailyDose;
}

// MS_PER_DAY is now imported from ./time (#99).

export function formatArabicDate(dateStr: string, includeWeekday: boolean = true): string {
  try {
    const d = parseUtcDate(dateStr);
    if (!d) return dateStr;
    const options: Intl.DateTimeFormatOptions = {
      weekday: includeWeekday ? 'long' : undefined,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    };
    // toLocaleDateString reads the UTC fields when timeZone is UTC.
    return d.toLocaleDateString('ar-EG', { ...options, timeZone: 'UTC' });
  } catch {
    return dateStr;
  }
}

/**
 * Format an ISO timestamp string or epoch into Arabic 12-hour time format (e.g. "10:30 ص" or "2:15 م").
 * Returns an empty string if timestamp is invalid, missing, or does not contain time.
 */
export function formatLogTime(timestamp?: string | number): string {
  if (!timestamp) return '';
  const str = String(timestamp).trim();
  // Ensure it actually contains time information (ISO string with 'T' or time with ':' or epoch milliseconds)
  if (!str.includes('T') && !str.includes(':') && !/^\d{10,}$/.test(str)) {
    return '';
  }
  try {
    const d = /^\d{10,}$/.test(str) ? new Date(Number(str)) : new Date(str);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = d.getMinutes();
    const isPM = h >= 12;
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    const minutePadded = m < 10 ? `0${m}` : `${m}`;
    return `${hour12}:${minutePadded} ${isPM ? 'م' : 'ص'}`;
  } catch {
    return '';
  }
}

export function getDaysDifference(fromDateStr: string, toDateStr: string): number {
  try {
    const date1 = parseUtcDate(fromDateStr);
    const date2 = parseUtcDate(toDateStr);
    if (!date1 || !date2) return 0;
    // Round before dividing so a 23:59:59.999 → 00:00:00.001 boundary
    // still collapses to a whole number of days.
    const diffDays = Math.round((date2.getTime() - date1.getTime()) / MS_PER_DAY);
    return Math.max(0, diffDays);
  } catch {
    return 0;
  }
}

/**
 * The dynamic balance that the UI actually displays (Phase 7 dual-balance).
 *
 * **Dual model (D7-1):**
 * - `med.currentPills` is the **durable committed stock snapshot** (and
 *   horizon companion `lastSyncDate`). It is **not** necessarily the
 *   number that must be shown to the user at every moment.
 * - `effectiveCurrentPills` is the **read-only projection** of live UI
 *   balance: from that snapshot, subtract
 *   {@link computeDueDoseBreakdown}'s `fullDueUnits` (respecting
 *   consume/skip markers). Clamped at 0.
 *
 * This is the SINGLE source of truth for "how many pills does the user
 * actually have right now" in the UI. Callers must NOT read
 * `med.currentPills` directly for display. Durable mutations (Exact
 * apply, legacy catch-up, Take/Restore, refill, envelopes) continue to
 * read/write `currentPills`.
 *
 * **Projection-only contract (must not change):**
 * - Does not write storage
 * - Does not mutate `currentPills` or `lastSyncDate`
 * - Does not create logs or Exact events
 * - Uses `computeDueDoseBreakdown().fullDueUnits` only
 *
 * Timing model:
 *   - `reminderTime`-gated med (`reminderEnabled` + valid
 *     `reminderTime`): today's dose is NOT due before `reminderTime`.
 *     So at 15:00 with reminderTime 20:00, the projection does NOT
 *     include today's dose. Once `now >= reminderTime` (and the user
 *     hasn't manually consumed today), today's dose is projected.
 *   - Multi-dose: per-slot wall-clock via {@link todayDueUnits}.
 *   - Legacy med (no reminder): a day's dose is due at the start of
 *     the calendar day — the pre-change behavior.
 *
 * The manual-consume interaction (`lastConsumedDate === today` / slot
 * markers) yields 0 due for that occurrence: projection returns
 * snapshot without re-charging an already-handled dose.
 *
 * Behavior:
 *   - `autoDeductEnabled === false` → returns `currentPills` unchanged
 *     (the user has paused auto-deduction; the stored snapshot IS the
 *     effective balance).
 *   - `dailyDose`/schedule amount ≤ 0 → returns `currentPills`.
 *   - Otherwise: `max(0, currentPills - fullDueUnits)`.
 *
 * @param med The medication.
 * @param todayStr Optional "today" override (YYYY-MM-DD) — used by
 *   tests for determinism. Defaults to getTodayDateString(). Should
 *   equal the local calendar date of `now` for the reminderTime-gating
 *   to be meaningful.
 * @param now Optional current moment — for tests. Defaults to new Date().
 */
export function effectiveCurrentPills(
  med: Medication,
  todayStr: string = getTodayDateString(),
  now: Date = new Date()
): number {
  // Auto-deduction paused → the stored snapshot IS the live balance.
  if (med.autoDeductEnabled === false) return med.currentPills;
  // No consumption rate → can't project forward meaningfully.
  if (dailyScheduleAmount(med) <= 0) return med.currentPills;
  const { fullDueUnits } = computeDueDoseBreakdown(med, now, todayStr);
  if (fullDueUnits <= 0) return med.currentPills;
  return Math.max(0, med.currentPills - fullDueUnits);
}

/**
 * Count of individual multi-dose *slots* that are currently auto-due
 * (historical unconsumed slots + today's time-elapsed unconsumed slots).
 * Not a day count and not a unit count — use fullDueUnits for stock.
 */
export function countDueDoseEvents(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString()
): number {
  if (!hasDoseSchedule(med) || !med.doseSchedule) return 0;
  if (med.autoDeductEnabled === false) return 0;
  const lastSync = med.lastSyncDate || todayStr;
  const totalDays = getDaysDifference(lastSync, todayStr);
  const betweenDays = Math.max(0, totalDays - 1);
  let events = 0;
  // Historical fully-elapsed days
  for (let i = 1; i <= betweenDays; i++) {
    const day = addDaysToDateStr(lastSync, i);
    for (const d of med.doseSchedule) {
      if ((Number(d.amount) || 0) <= 0) continue;
      if (isDoseConsumedOnDate(med, d.id, day)) continue;
      if (isDoseSkippedOnDate(med, d.id, day)) continue;
      events += 1;
    }
  }
  // Today: time-elapsed unconsumed
  if (localDateStr(now) === todayStr) {
    const nowMin = nowMinutesLocal(now);
    for (const d of med.doseSchedule) {
      if ((Number(d.amount) || 0) <= 0) continue;
      const tMin = timeToMinutes(d.time);
      if (tMin < 0 || nowMin < tMin) continue;
      if (isDoseConsumedOnDate(med, d.id, todayStr)) continue;
      if (isDoseSkippedOnDate(med, d.id, todayStr)) continue;
      events += 1;
    }
  }
  return events;
}

/**
 * Count of auto-due dose *events* or *days*, depending on med type.
 *
 * - Legacy / single-dose: integer number of due calendar days.
 * - Multi-dose: integer count of due **dose slots** (via
 *   {@link countDueDoseEvents}). Not units and not day-equivalents.
 *
 * Stock / projection must use {@link computeDueDoseBreakdown}.fullDueUnits.
 * Do not multiply this return value by dailyDose for multi-dose meds.
 */
export function countDueAutoDoses(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString()
): number {
  if (hasDoseSchedule(med)) {
    return countDueDoseEvents(med, now, todayStr);
  }
  if (med.dailyDose <= 0) return 0;
  if (med.lastConsumedDate === todayStr) return 0;
  const lastDate = med.lastSyncDate || todayStr;
  const totalDays = getDaysDifference(lastDate, todayStr);
  if (isReminderTimeGated(med)) {
    const betweenDays = Math.max(0, totalDays - 1);
    const reminderMin = timeToMinutes(med.reminderTime as string);
    const todayDue =
      localDateStr(now) === todayStr && nowMinutesLocal(now) >= reminderMin
        ? 1
        : 0;
    return betweenDays + todayDue;
  }
  if (totalDays <= 0) return 0;
  return totalDays;
}

/**
 * Per-med due-dose breakdown shared by the settlement functions.
 *
 * - `fullDueDoses`: the dynamic projection count (past + today-if-due).
 *   Used by {@link effectiveCurrentPills} and the legacy settlement
 *   path (which settles today's dose at the start of the calendar day).
 * - `pastDueDoses`: the past-only count (excludes today's auto-dose).
 *   Used by the reminderTime-gated mutations (refill / consume /
 *   dose-change / toggle): settling only past days leaves today's dose
 *   dynamic so a later manual consume can replace it without
 *   double-deduction; today's dose is settled at the next existing
 *   execution point (a later mutation), NOT automatically at the
 *   calendar-day boundary.
 *
 * For legacy (non-gated) meds, both equal `totalDays` (today is settled
 * at the start of the calendar day — the pre-change behavior).
 */
export interface DueDoseBreakdown {
  totalDays: number;
  betweenDays: number;
  todayDue: boolean;
  consumedToday: boolean;
  gated: boolean;
  /** Day-count of due doses for legacy paths. Multi-dose still fills this for log copy; stock uses fullDueUnits. */
  fullDueDoses: number;
  pastDueDoses: number;
  /** Units of stock due (authoritative for projection + settlement). */
  fullDueUnits: number;
  pastDueUnits: number;
  /** Units due from today's schedule only (time-elapsed, not consumed). */
  todayDueUnits: number;
}

export function computeDueDoseBreakdown(
  med: Medication,
  now: Date,
  todayStr: string
): DueDoseBreakdown {
  const totalDays = getDaysDifference(med.lastSyncDate || todayStr, todayStr);
  const multi = hasDoseSchedule(med);
  // Multi-dose is always time-gated per slot. Legacy uses reminderTime gate.
  const gated = multi || isReminderTimeGated(med);
  const betweenDays = gated ? Math.max(0, totalDays - 1) : 0;

  // consumedToday: legacy = lastConsumedDate; multi = all slots consumed today
  // (used by mutation lastSync rules). Per-slot consumption is checked in
  // todayDueUnits.
  let consumedToday = med.lastConsumedDate === todayStr;
  if (multi && med.doseSchedule) {
    const allConsumed =
      med.doseSchedule.length > 0 &&
      med.doseSchedule.every((d) => isDoseConsumedOnDate(med, d.id, todayStr));
    consumedToday = allConsumed;
  }

  const dayAmount = dailyScheduleAmount(med);
  let todayUnits = 0;
  let todayDue = false;

  if (med.autoDeductEnabled !== false && dayAmount > 0) {
    todayUnits = todayDueUnits(med, now, todayStr);
    todayDue = todayUnits > 0;
  }

  let fullDueDoses = 0;
  let pastDueDoses = 0;
  let pastDueUnits = 0;
  let fullDueUnits = 0;

  if (med.autoDeductEnabled !== false && dayAmount > 0) {
    if (multi) {
      // Each fully-elapsed past day: skip slots with known consume on that
      // date; unrecorded slots use current schedule amounts (unknown-
      // history fallback — not reconstructed past configuration).
      const lastSync = med.lastSyncDate || todayStr;
      pastDueUnits = historicalRangeDueUnits(med, lastSync, todayStr);
      fullDueUnits = pastDueUnits + todayUnits;
      pastDueDoses = betweenDays;
      fullDueDoses = betweenDays + (todayDue ? 1 : 0);
    } else if (gated) {
      if (!consumedToday) {
        fullDueDoses = betweenDays + (todayDue ? 1 : 0);
        pastDueDoses = betweenDays;
        pastDueUnits = pastDueDoses * med.dailyDose;
        fullDueUnits = fullDueDoses * med.dailyDose;
      }
    } else if (totalDays > 0) {
      // No explicit doseSchedule: day-level due uses dailyDose for each day
      // in (lastSyncDate, today]. Consume/skip exclusion requires explicit
      // doseSchedule markers (no LEGACY_DOSE_ID identity).
      fullDueDoses = totalDays;
      pastDueDoses = totalDays;
      pastDueUnits = totalDays * med.dailyDose;
      fullDueUnits = totalDays * med.dailyDose;
    }
  }

  return {
    totalDays,
    betweenDays,
    todayDue,
    consumedToday,
    gated,
    fullDueDoses,
    pastDueDoses,
    fullDueUnits,
    pastDueUnits,
    todayDueUnits: todayUnits,
  };
}

/**
 * The dynamic "days left" estimate derived from effectiveCurrentPills.
 *
 * Equivalent to `Math.floor(effectiveCurrentPills(med, todayStr) / med.dailyDose)`
 * when `dailyDose > 0`, else `NEVER_DEPLETES_DAYS` (sentinel meaning "never
 * depletes").
 * Clamped at 0.
 *
 * Provided as a convenience for `calculateMedicationStatus` and
 * `getDepletionDate` (and tests) so they all share one definition.
 */
export function effectiveDaysLeft(
  med: Medication,
  todayStr: string = getTodayDateString()
): number {
  // Prefer schedule sum so multi-dose stays correct even if dailyDose
  // was briefly out of sync with doseSchedule amounts.
  const dayAmt = dailyScheduleAmount(med);
  if (dayAmt <= 0) return NEVER_DEPLETES_DAYS;
  const eff = effectiveCurrentPills(med, todayStr);
  if (eff <= 0) return 0;
  return Math.floor(eff / dayAmt);
}

export function getDepletionDate(med: Medication): {
  dateStr: string;
  formattedArabic: string;
  daysLeft: number;
} {
  // Use the DYNAMIC balance (projected from currentPills + lastSyncDate)
  // — not the raw stored snapshot. This keeps the depletion date
  // correct even if the app was closed for many days and the snapshot
  // has not been re-settled yet.
  const eff = effectiveCurrentPills(med);
  const daysLeft = effectiveDaysLeft(med);

  // Compute today's UTC date, then add `daysLeft` days in UTC so the
  // result is a calendar date that doesn't shift by an hour across DST.
  const todayUtc = parseUtcDate(getTodayDateString()) ?? new Date(Date.UTC(1970, 0, 1));
  const targetUtc = new Date(todayUtc.getTime() + daysLeft * MS_PER_DAY);
  const dateStr = formatUtcDateString(targetUtc);

  let formattedArabic: string;
  if (eff <= 0) {
    formattedArabic = 'نفد المخزون بالكامل';
  } else if (daysLeft === 0) {
    formattedArabic = 'ينفد اليوم';
  } else if (daysLeft === 1) {
    formattedArabic = 'غداً';
  } else if (daysLeft === 2) {
    formattedArabic = 'بعد غد';
  } else {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    };
    formattedArabic = targetUtc.toLocaleDateString('ar-EG', options);
  }

  return {
    dateStr,
    formattedArabic,
    daysLeft,
  };
}

/**
 * Compute the absolute timestamp (epoch ms) at which the medication
 * is projected to cross the critical threshold.
 *
 * Returns `null` in cases where scheduling an alarm is meaningless or
 * unsafe — callers should treat null as "do not schedule":
 *   - `dailyDose <= 0` → no consumption rate → no projected critical
 *     date. Caller must skip scheduling.
 *   - `daysLeft <= criticalThresholdDays` → the med is ALREADY at or
 *     below the user-configured threshold. The one-shot alarm is only
 *     for FUTURE crossings; the existing alert effect (useStockAlerts)
 *     handles the "already critical on app open" case. Returning null
 *     here prevents repeated immediate alerts from being scheduled on
 *     every app launch.
 *   - `autoDeductEnabled === false` AND effective balance > critical
 *     threshold → the balance is frozen, it will never cross the
 *     critical threshold without a refill. (If it's already below,
 *     we still return null — see above.)
 *
 * Otherwise returns a future timestamp computed as:
 *   today + (effectiveDaysLeft - criticalThresholdDays) days
 * at the user's local 09:00 AM (a reasonable "morning reminder" time
 * — we don't need second-precision; critical alerts don't need to
 * fire at midnight, and 9 AM avoids the device's quiet-hours window).
 *
 * The local-time choice is why this returns a Date and not a UTC ms.
 *
 * Boot persistence: on Android, the @capacitor/local-notifications
 * plugin persists scheduled notifications in SharedPreferences and
 * re-arms them via its `LocalNotificationRestoreReceiver` on
 * BOOT_COMPLETED (also LOCKED_BOOT_COMPLETED + QUICKBOOT_POWERON).
 * Past-due notifications are rescheduled to fire ~15 seconds after
 * boot. So scheduled one-shot critical alarms survive device reboots
 * without the user opening the app — no extra code required.
 *
 * @param med The medication.
 * @param todayStr Optional "today" override (YYYY-MM-DD) — for tests.
 */
export function getCriticalAlarmDate(
  med: Medication,
  todayStr: string = getTodayDateString()
): number | null {
  // No consumption rate → no projected crossing. Caller skips.
  if (dailyScheduleAmount(med) <= 0) return null;

  const criticalThresholdDays = getCriticalThresholdDays(med);
  const daysLeft = effectiveDaysLeft(med, todayStr);

  // Already at or below the critical threshold → return null.
  // The foreground useStockAlerts hook handles immediate notifications.
  // The one-shot alarm is only for FUTURE crossings.
  if (daysLeft <= criticalThresholdDays) return null;

  // For a frozen med (autoDeduct off) with sufficient balance, the
  // balance won't change over time → no future crossing.
  if (med.autoDeductEnabled === false) return null;

  const daysUntilCritical = daysLeft - criticalThresholdDays;
  if (daysUntilCritical <= 0) return null;

  const todayUtc = parseUtcDate(todayStr) ?? new Date(Date.UTC(1970, 0, 1));
  const targetUtcMs = todayUtc.getTime() + daysUntilCritical * MS_PER_DAY;
  const targetUtcDate = new Date(targetUtcMs);
  const target = new Date(
    targetUtcDate.getUTCFullYear(),
    targetUtcDate.getUTCMonth(),
    targetUtcDate.getUTCDate(),
    CRITICAL_ALARM_FIRE_HOUR, // 9 AM local
    0, 0, 0
  );
  return target.getTime();
}

