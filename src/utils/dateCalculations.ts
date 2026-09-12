import { Medication, ConsumptionLog, getCriticalThresholdDays } from '../types';
import { generateId } from './id';
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
 * a reminderTime-gated settlement that does NOT settle today's dose
 * advances lastSyncDate to yesterday so today's dose stays projectable
 * (and is settled on day rollover or a later mutation).
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
 * The dynamic balance that the UI actually displays.
 *
 * `med.currentPills` is the last "settled" snapshot — the value at
 * `med.lastSyncDate`. From that snapshot, we project forward by the
 * number of auto-deductible doses currently due (see
 * {@link countDueAutoDoses}), deducting `dailyDose` per dose. The
 * result is clamped at 0 so the displayed balance never goes negative.
 *
 * This is the SINGLE source of truth for "how many pills does the user
 * actually have right now" in the entire UI. Callers should NEVER read
 * `med.currentPills` directly for display.
 *
 * Timing model:
 *   - `reminderTime`-gated med (`reminderEnabled` + valid
 *     `reminderTime`): today's dose is NOT due before `reminderTime`.
 *     So at 15:00 with reminderTime 20:00, the projection does NOT
 *     include today's dose. Once `now >= reminderTime` (and the user
 *     hasn't manually consumed today), today's dose is projected.
 *   - Legacy med (no reminder): a day's dose is due at the start of
 *     the calendar day — the pre-change behavior.
 *
 * The manual-consume interaction (`lastConsumedDate === today`) yields
 * 0 due doses: a manual consume pre-settles the snapshot (currentPills
 * already reflects the projection + the manual dose, lastSyncDate =
 * today), so this function returns currentPills as-is — no spurious
 * re-deduction of the already-consumed dose.
 *
 * Behavior:
 *   - `autoDeductEnabled === false` → returns `currentPills` unchanged
 *     (the user has paused auto-deduction; the stored snapshot IS the
 *     effective balance).
 *   - `dailyDose <= 0` → returns `currentPills` (no consumption rate to
 *     project forward; effectively "unknown rate" — show the snapshot).
 *   - Otherwise: `max(0, currentPills - countDueAutoDoses(med, now, today) * dailyDose)`.
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
  if (med.dailyDose <= 0) return med.currentPills;
  const dueDoses = countDueAutoDoses(med, now, todayStr);
  if (dueDoses <= 0) return med.currentPills;
  const projected = med.currentPills - dueDoses * med.dailyDose;
  return Math.max(0, projected);
}

/**
 * Count the number of auto-deductible daily doses currently due for
 * `med` — the dynamic projection count consumed by
 * {@link effectiveCurrentPills}.
 *
 * Deterministic from: currentPills (caller clamps), lastSyncDate,
 * dailyDose, reminderEnabled, reminderTime, lastConsumedDate, and the
 * current moment (`now`).
 *
 * Gating:
 *   - `reminderEnabled === true` with a valid `reminderTime`: a day's
 *     dose becomes due at `reminderTime` on that calendar day (local
 *     time). Fully-elapsed past days (strictly between lastSyncDate and
 *     today) are each due. Today's dose is due iff `now` is on the same
 *     local calendar day as `todayStr` AND `now >= today's reminderTime`
 *     AND the user has not already consumed it manually
 *     (`lastConsumedDate !== todayStr`).
 *   - Otherwise (reminder disabled / no valid reminderTime): legacy
 *     calendar-day behavior — every calendar day strictly after
 *     lastSyncDate up to and including today is due.
 *
 * Returns 0 when `dailyDose <= 0`, when no days have passed, or when
 * the user already consumed today's dose manually (the manual consume
 * pre-settled the projection).
 */
export function countDueAutoDoses(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString()
): number {
  if (med.dailyDose <= 0) return 0;
  const lastDate = med.lastSyncDate || todayStr;
  const totalDays = getDaysDifference(lastDate, todayStr);
  if (totalDays <= 0) return 0;
  if (med.lastConsumedDate === todayStr) return 0;
  if (isReminderTimeGated(med)) {
    const betweenDays = Math.max(0, totalDays - 1);
    const reminderMin = timeToMinutes(med.reminderTime as string);
    const todayDue =
      localDateStr(now) === todayStr && nowMinutesLocal(now) >= reminderMin
        ? 1
        : 0;
    return betweenDays + todayDue;
  }
  return totalDays;
}

/**
 * Per-med due-dose breakdown shared by the settlement functions.
 *
 * - `fullDueDoses`: the dynamic projection count (past + today-if-due).
 *   Used by {@link effectiveCurrentPills} and the legacy settlement
 *   path (which settles today's dose at the start of the calendar day).
 * - `pastDueDoses`: the past-only count (excludes today's auto-dose).
 *   Used by the reminderTime-gated settlement (sync / refill / consume /
 *   dose-change / toggle): settling only past days leaves today's dose
 *   dynamic so a later manual consume can replace it without
 *   double-deduction; it is settled on day rollover or a mutation.
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
  fullDueDoses: number;
  pastDueDoses: number;
}

export function computeDueDoseBreakdown(
  med: Medication,
  now: Date,
  todayStr: string
): DueDoseBreakdown {
  const totalDays = getDaysDifference(med.lastSyncDate || todayStr, todayStr);
  const consumedToday = med.lastConsumedDate === todayStr;
  const gated = isReminderTimeGated(med);
  const betweenDays = gated ? Math.max(0, totalDays - 1) : 0;
  const reminderMin = gated ? timeToMinutes(med.reminderTime as string) : -1;
  const todayDue =
    gated &&
    totalDays > 0 &&
    !consumedToday &&
    localDateStr(now) === todayStr &&
    nowMinutesLocal(now) >= reminderMin;
  let fullDueDoses = 0;
  let pastDueDoses = 0;
  // A frozen med (autoDeductEnabled === false) is NOT auto-deducted —
  // its snapshot IS the live balance, so settlement must not project any
  // past auto-doses either. (effectiveCurrentPills checks this itself;
  // the settlement helpers read pastDueDoses/fullDueDoses here.)
  if (med.autoDeductEnabled !== false && med.dailyDose > 0 && totalDays > 0 && !consumedToday) {
    if (gated) {
      fullDueDoses = betweenDays + (todayDue ? 1 : 0);
      pastDueDoses = betweenDays;
    } else {
      fullDueDoses = totalDays;
      pastDueDoses = totalDays;
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
  };
}

/**
 * Settlement lastSyncDate rule for the reminderTime-gated settlement
 * (which settles ONLY past days, leaving today dynamic).
 *
 * - `dueDoses === 0` → keep the existing lastSyncDate (default to
 *   todayStr if it was empty). Nothing was settled; today's dose stays
 *   pending exactly as before.
 * - reminderTime-gated with `dueDoses > 0` and no manual consume today
 *   → yesterday: the past days are now settled, but today's dose is
 *   NOT (it stays projectable via {@link effectiveCurrentPills}'s
 *   `todayDue` until manual consume or day rollover).
 * - Legacy path (or reminderTime-gated with a manual consume today)
 *   → today: legacy settles today's dose at the start of the calendar
 *   day; a manual consume today already set lastSyncDate = today.
 */
export function settlementLastSyncDate(
  med: Medication,
  todayStr: string,
  dueDoses: number,
  consumedToday: boolean,
  gated: boolean
): string {
  if (dueDoses <= 0) return med.lastSyncDate || todayStr;
  if (gated && !consumedToday) return addDaysToDateStr(todayStr, -1);
  return todayStr;
}

/**
 * Settlement lastSyncDate rule for MUTATIONS (refill / dose-change /
 * auto-deduct toggle / refill-undo). Unlike {@link settlementLastSyncDate}
 * (used by sync, which keeps lastSyncDate when nothing is settled), a
 * mutation always advances lastSyncDate so the snapshot reflects the
 * post-mutation state:
 *   - Legacy: today (the pre-change behavior — always bump on mutation).
 *   - reminderTime-gated with a manual consume today: today (the manual
 *     consume already settled today's dose).
 *   - reminderTime-gated otherwise: yesterday — today's dose stays
 *     dynamic (projectable via todayDue, and settled on day rollover or
 *     a later mutation). This lets, e.g., a dose change apply the NEW
 *     dose to today's (still-dynamic) dose.
 */
export function mutationSettlementLastSyncDate(
  todayStr: string,
  consumedToday: boolean,
  gated: boolean
): string {
  if (gated && !consumedToday) return addDaysToDateStr(todayStr, -1);
  return todayStr;
}

/**
 * Reverse one refill while preserving all movements that happened after it.
 * The refill is removed from the live balance, not from the stored snapshot
 * that existed when the refill was created. If later consumption used some
 * or all of that supply, only the remaining balance can be reversed.
 */
export function reverseRefill(
  med: Medication,
  refillAmount: number,
  todayStr: string = getTodayDateString(),
  now: Date = new Date()
): { updatedMed: Medication; reversedAmount: number } {
  const breakdown = computeDueDoseBreakdown(med, now, todayStr);
  // For the reminderTime-gated path, settle at the PAST-only balance
  // (exclude today's projected auto-dose) so a later manual consume can
  // replace today's dose without double-deduction. For legacy, settle
  // at the full effective balance (today included — pre-change behavior).
  const settleBase = breakdown.gated
    ? Math.max(0, med.currentPills - breakdown.pastDueDoses * med.dailyDose)
    : Math.max(0, effectiveCurrentPills(med, todayStr, now));
  const reversedAmount = Math.min(Math.max(0, refillAmount), settleBase);
  const newLastSync = mutationSettlementLastSyncDate(
    todayStr,
    breakdown.consumedToday,
    breakdown.gated
  );

  return {
    updatedMed: {
      ...med,
      currentPills: Math.max(0, settleBase - reversedAmount),
      lastSyncDate: newLastSync,
    },
    reversedAmount,
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
  if (med.dailyDose <= 0) return NEVER_DEPLETES_DAYS;
  const eff = effectiveCurrentPills(med, todayStr);
  if (eff <= 0) return 0;
  return Math.floor(eff / med.dailyDose);
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

export interface AutoSyncResult {
  updatedMeds: Medication[];
  newLogs: ConsumptionLog[];
  deductedSummary: {
    medName: string;
    daysPassed: number;
    pillsDeducted: number;
    remainingPills: number;
  }[];
}

export function syncAutoDailyDeductions(
  medications: Medication[],
  todayStr: string = getTodayDateString(),
  now: Date = new Date()
): AutoSyncResult {
  const updatedMeds: Medication[] = [];
  const newLogs: ConsumptionLog[] = [];
  const deductedSummary: AutoSyncResult['deductedSummary'] = [];

  medications.forEach((med) => {
    const breakdown = computeDueDoseBreakdown(med, now, todayStr);

    // For the reminderTime-gated path, sync settles ONLY fully-elapsed
    // past days (betweenDays). Today's dose is left dynamic (projected
    // by effectiveCurrentPills via todayDue) so a later manual consume
    // can replace it without double-deduction; it is settled on day
    // rollover or a mutation. For the legacy path, sync settles
    // totalDays (today included) — the pre-change behavior.
    const dueDoses = breakdown.gated ? breakdown.pastDueDoses : breakdown.fullDueDoses;

    if (med.autoDeductEnabled !== false && med.dailyDose > 0 && dueDoses > 0 && !breakdown.consumedToday) {
      const pillsToDeduct = Math.min(med.currentPills, dueDoses * med.dailyDose);
      const newPills = Math.max(0, med.currentPills - pillsToDeduct);
      const newLastSync = settlementLastSyncDate(
        med,
        todayStr,
        dueDoses,
        breakdown.consumedToday,
        breakdown.gated
      );

      updatedMeds.push({
        ...med,
        currentPills: newPills,
        lastSyncDate: newLastSync,
      });

      if (pillsToDeduct > 0) {
        newLogs.push({
          id: generateId('log'),
          medicationId: med.id,
          medicationName: med.name,
          type: 'auto_daily',
          amount: -pillsToDeduct,
          date: todayStr,
          timestamp: new Date().toISOString(),
          description: `خصم تلقائي لمرور ${dueDoses} ${dueDoses === 1 ? 'يوم' : 'أيام'} (-${pillsToDeduct} ${med.unit})`,
        });

        deductedSummary.push({
          medName: med.name,
          daysPassed: dueDoses,
          pillsDeducted: pillsToDeduct,
          remainingPills: newPills,
        });
      }
    } else {
      // Just keep as is, ensuring lastSyncDate is set
      updatedMeds.push({
        ...med,
        lastSyncDate: med.lastSyncDate || todayStr,
      });
    }
  });

  return {
    updatedMeds,
    newLogs,
    deductedSummary,
  };
}

/**
 * Settlement helper for dose change.
 *
 * When the user changes a medication's `dailyDose`, we MUST NOT just
 * apply the new dose going forward from `lastSyncDate` — that would
 * retroactively apply the new rate to all days that actually consumed
 * at the OLD rate, corrupting the balance.
 *
 * Instead, we "settle" the period [lastSyncDate, today] at the OLD dose:
 *   1. Compute consumption using the OLD dose up to today.
 *   2. Save the resulting currentPills (the settled snapshot).
 *   3. Set lastSyncDate = today.
 *   4. Change dailyDose to the new value.
 *
 * After settlement, `effectiveCurrentPills` (with the new dose) starts
 * projecting from today forward — applying the new rate only to future
 * days, exactly as the user expects.
 *
 * `autoDeductEnabled === false` is respected: no settlement deduction
 * happens, but we still bump lastSyncDate to today so the new dose
 * starts projecting from now (cosmetically identical, since the
 * effective balance is just currentPills either way).
 *
 * `dailyDose <= 0` (old dose) means no consumption rate → just update
 * lastSyncDate + change the dose.
 *
 * Returns the settled med + the consumption log for the settlement
 * period (if any pills were deducted). The caller is responsible for
 * persisting both.
 */
export function settleDoseChange(
  med: Medication,
  newDose: number,
  todayStr: string = getTodayDateString(),
  now: Date = new Date()
): { updatedMed: Medication; log: ConsumptionLog | null } {
  const oldDose = med.dailyDose;
  const breakdown = computeDueDoseBreakdown(med, now, todayStr);
  // Settle the elapsed period at the OLD dose. For the reminderTime-gated
  // path, settle past days only (betweenDays) — today's dose is left
  // dynamic. For legacy, settle totalDays (today included).
  const dueDoses = breakdown.gated ? breakdown.pastDueDoses : breakdown.fullDueDoses;

  // Compute the settled balance using the OLD dose.
  // Only deduct when autoDeduct is active and there's a positive old rate.
  let pillsDeducted = 0;
  let settledPills = med.currentPills;
  if (med.autoDeductEnabled !== false && oldDose > 0 && dueDoses > 0) {
    pillsDeducted = Math.min(med.currentPills, dueDoses * oldDose);
    settledPills = Math.max(0, med.currentPills - pillsDeducted);
  }

  const newLastSync = mutationSettlementLastSyncDate(
    todayStr,
    breakdown.consumedToday,
    breakdown.gated
  );

  const updatedMed: Medication = {
    ...med,
    currentPills: settledPills,
    lastSyncDate: newLastSync,
    dailyDose: newDose,
  };

  const log: ConsumptionLog | null =
    pillsDeducted > 0
      ? {
          id: generateId('log'),
          medicationId: med.id,
          medicationName: med.name,
          type: 'auto_daily',
          amount: -pillsDeducted,
          date: todayStr,
          timestamp: new Date().toISOString(),
          description: `تسوية عند تغيير الجرعة: خصم ${dueDoses} ${dueDoses === 1 ? 'يوم' : 'أيام'} بالجرعة السابقة (${oldDose}/يوم) (-${pillsDeducted} ${med.unit})`,
        }
      : null;

  return { updatedMed, log };
}

/**
 * Settlement helper for `autoDeductEnabled` toggling.
 *
 * When the user toggles the auto-deduction flag, the snapshot must be
 * re-settled at the live effective balance before the new state takes
 * effect — otherwise the displayed balance will silently become
 * inconsistent with reality.
 *
 * Behavior:
 *   - true → false (turning auto-deduction OFF after it was ON):
 *     The med was being auto-deducted up to today. Settle the period
 *     [lastSyncDate, today] at the OLD active rate: deduct
 *     daysPassed*dailyDose from currentPills (clamped at 0), set
 *     lastSyncDate=today. THEN flip autoDeductEnabled=false.
 *     Without this, the displayed balance would jump back UP to the
 *     stale snapshot value the moment the flag flips (because
 *     effectiveCurrentPills returns currentPills unchanged when
 *     autoDeduct is false), undoing all consumption since lastSyncDate.
 *   - false → true (turning auto-deduction ON after it was OFF):
 *     The med was FROZEN for the elapsed period — the user wasn't
 *     consuming during that time, so we must NOT retroactively deduct.
 *     Keep currentPills unchanged (the frozen balance is the live
 *     balance). Set lastSyncDate=today so the new auto-deduction
 *     starts fresh from today forward. THEN flip autoDeductEnabled=true.
 *     Without the lastSyncDate bump, enabling auto-deduction would
 *     instantly deduct daysPassed*dailyDose retroactively for the
 *     frozen period — wrong.
 *
 * Edge cases:
 *   - dailyDose <= 0: no consumption rate → no deduction either way.
 *     Just bump lastSyncDate and flip the flag.
 *   - undefined → false (default-true med being turned OFF): treat
 *     undefined as "auto-deduct was ON" (default), so settle at the
 *     old active rate.
 *   - true → true / false → false: no transition, but the caller may
 *     still want to bump lastSyncDate — left to the caller's discretion
 *     (this helper is only called when the flag actually changes).
 *
 * Returns the settled med + (optionally) a consumption log for the
 * settlement deduction. The log is only produced for the true→false
 * transition with a positive dailyDose and elapsed days (i.e. when
 * pills were actually deducted). The caller is responsible for
 * persisting both.
 */
export function settleAutoDeductToggle(
  med: Medication,
  newState: boolean,
  todayStr: string = getTodayDateString(),
  now: Date = new Date()
): { updatedMed: Medication; log: ConsumptionLog | null } {
  const wasActive = med.autoDeductEnabled !== false;
  const breakdown = computeDueDoseBreakdown(med, now, todayStr);
  // For the true→false settlement: settle the elapsed period. For the
  // reminderTime-gated path, settle past days only (betweenDays); for
  // legacy, settle totalDays (today included). lastSyncDate is bumped to
  // today in both cases — turning OFF freezes the balance (autoDeduct
  // projection is off), and turning ON must start fresh from today (no
  // retroactive deduction for the frozen period).
  const dueDoses = breakdown.gated ? breakdown.pastDueDoses : breakdown.fullDueDoses;

  let pillsDeducted = 0;
  let settledPills = med.currentPills;

  // Only deduct when:
  //   - the med WAS being auto-deducted (wasActive === true), AND
  //   - we're turning it OFF (newState === false), AND
  //   - there's a positive consumption rate, AND
  //   - due doses exist.
  // For the false→true transition, we explicitly do NOT deduct
  // retroactively for the frozen period — currentPills stays unchanged.
  if (wasActive && !newState && med.dailyDose > 0 && dueDoses > 0) {
    pillsDeducted = Math.min(med.currentPills, dueDoses * med.dailyDose);
    settledPills = Math.max(0, med.currentPills - pillsDeducted);
  }

  // lastSyncDate: for the legacy path, always today (the pre-change
  // behavior — bumping to today on mutation). For the reminderTime-gated
  // path, yesterday (or today if the user manually consumed today): today's
  // dose stays dynamic so re-enabling auto-deduction sees today's dose
  // become due at reminderTime the same day, with no retroactive deduction
  // for the frozen period (betweenDays = 0 once lastSyncDate = yesterday).
  const newLastSync = mutationSettlementLastSyncDate(
    todayStr,
    breakdown.consumedToday,
    breakdown.gated
  );

  const updatedMed: Medication = {
    ...med,
    currentPills: settledPills,
    lastSyncDate: newLastSync,
    autoDeductEnabled: newState,
  };

  const log: ConsumptionLog | null =
    pillsDeducted > 0
      ? {
          id: generateId('log'),
          medicationId: med.id,
          medicationName: med.name,
          type: 'auto_daily',
          amount: -pillsDeducted,
          date: todayStr,
          timestamp: new Date().toISOString(),
          description: `تسوية عند إيقاف الخصم التلقائي: خصم ${dueDoses} ${dueDoses === 1 ? 'يوم' : 'أيام'} بالجرعة الحالية (${med.dailyDose}/يوم) (-${pillsDeducted} ${med.unit})`,
        }
      : null;

  return { updatedMed, log };
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
  if (med.dailyDose <= 0) return null;

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

