import { Medication, ConsumptionLog, getCriticalThresholdDays } from '../types';
import { generateId } from './id';
import { MS_PER_DAY, NEVER_DEPLETES_DAYS, CRITICAL_ALARM_FIRE_HOUR } from './time';

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
 * number of whole days that have passed since `lastSyncDate`, deducting
 * `dailyDose` per day. The result is clamped at 0 so the displayed
 * balance never goes negative.
 *
 * This is the SINGLE source of truth for "how many pills does the user
 * actually have right now" in the entire UI. Callers should NEVER read
 * `med.currentPills` directly for display — that would silently break
 * the "balance is correct even if the app was closed for 30 days"
 * invariant, because `currentPills` is only re-settled on app open,
 * manual consume, refill, or dose change (see syncAutoDailyDeductions).
 *
 * Behavior:
 *   - `autoDeductEnabled === false` → returns `currentPills` unchanged
 *     (the user has paused auto-deduction; the stored snapshot IS the
 *     effective balance).
 *   - `dailyDose <= 0` → returns `currentPills` (no consumption rate to
 *     project forward; effectively "unknown rate" — show the snapshot).
 *   - Otherwise: `max(0, currentPills - daysPassed(lastSyncDate, today) * dailyDose)`.
 *
 * The manual-consume interaction (lastConsumedDate === today) is
 * automatically handled: when the user takes a dose manually, the
 * consume handler sets `currentPills -= dose` AND `lastSyncDate = today`.
 * With `lastSyncDate === today`, `daysPassed === 0`, so this function
 * returns `currentPills` as-is — no spurious re-deduction of the
 * already-consumed dose. No special-casing needed here.
 *
 * @param med The medication.
 * @param todayStr Optional "today" override (YYYY-MM-DD) — used by
 *   tests for determinism. Defaults to getTodayDateString().
 */
export function effectiveCurrentPills(
  med: Medication,
  todayStr: string = getTodayDateString()
): number {
  // Auto-deduction paused → the stored snapshot IS the live balance.
  if (med.autoDeductEnabled === false) return med.currentPills;
  // No consumption rate → can't project forward meaningfully.
  if (med.dailyDose <= 0) return med.currentPills;
  const daysPassed = getDaysDifference(med.lastSyncDate || todayStr, todayStr);
  if (daysPassed <= 0) return med.currentPills;
  const projected = med.currentPills - daysPassed * med.dailyDose;
  return Math.max(0, projected);
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
  todayStr: string = getTodayDateString()
): { updatedMed: Medication; reversedAmount: number } {
  const liveBalance = Math.max(0, effectiveCurrentPills(med, todayStr));
  const reversedAmount = Math.min(Math.max(0, refillAmount), liveBalance);

  return {
    updatedMed: {
      ...med,
      currentPills: Math.max(0, liveBalance - reversedAmount),
      lastSyncDate: todayStr,
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
  todayStr: string = getTodayDateString()
): AutoSyncResult {
  const updatedMeds: Medication[] = [];
  const newLogs: ConsumptionLog[] = [];
  const deductedSummary: AutoSyncResult['deductedSummary'] = [];

  medications.forEach((med) => {
    // If no lastSyncDate, default to today
    const lastDate = med.lastSyncDate || todayStr;
    const daysPassed = getDaysDifference(lastDate, todayStr);

    // Consume-pill feature: if the user manually consumed a dose today
    // (lastConsumedDate === todayStr) AND the lastSyncDate is today
    // (meaning the manual consume already updated the sync), skip the
    // auto-deduction for this med. The manual consume subtracted the
    // dailyDose already and set lastSyncDate to today, so the auto-
    // deduction would double-deduct.
    const consumedToday = med.lastConsumedDate === todayStr;

    if (med.autoDeductEnabled !== false && daysPassed > 0 && med.dailyDose > 0 && !consumedToday) {
      const pillsToDeduct = Math.min(med.currentPills, daysPassed * med.dailyDose);
      const newPills = Math.max(0, med.currentPills - pillsToDeduct);

      updatedMeds.push({
        ...med,
        currentPills: newPills,
        lastSyncDate: todayStr,
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
          description: `خصم تلقائي لمرور ${daysPassed} ${daysPassed === 1 ? 'يوم' : 'أيام'} (-${pillsToDeduct} ${med.unit})`,
        });

        deductedSummary.push({
          medName: med.name,
          daysPassed,
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
  todayStr: string = getTodayDateString()
): { updatedMed: Medication; log: ConsumptionLog | null } {
  const oldDose = med.dailyDose;
  const daysPassed = getDaysDifference(med.lastSyncDate || todayStr, todayStr);

  // Compute the settled balance using the OLD dose.
  // Only deduct when autoDeduct is active and there's a positive old rate.
  let pillsDeducted = 0;
  let settledPills = med.currentPills;
  if (med.autoDeductEnabled !== false && oldDose > 0 && daysPassed > 0) {
    pillsDeducted = Math.min(med.currentPills, daysPassed * oldDose);
    settledPills = Math.max(0, med.currentPills - pillsDeducted);
  }

  const updatedMed: Medication = {
    ...med,
    currentPills: settledPills,
    lastSyncDate: todayStr,
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
          description: `تسوية عند تغيير الجرعة: خصم ${daysPassed} ${daysPassed === 1 ? 'يوم' : 'أيام'} بالجرعة السابقة (${oldDose}/يوم) (-${pillsDeducted} ${med.unit})`,
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
  todayStr: string = getTodayDateString()
): { updatedMed: Medication; log: ConsumptionLog | null } {
  const wasActive = med.autoDeductEnabled !== false;

  // Compute daysPassed for the period [lastSyncDate, today] using the
  // OLD state's projection behavior.
  const daysPassed = getDaysDifference(med.lastSyncDate || todayStr, todayStr);

  let pillsDeducted = 0;
  let settledPills = med.currentPills;

  // Only deduct when:
  //   - the med WAS being auto-deducted (wasActive === true), AND
  //   - we're turning it OFF (newState === false), AND
  //   - there's a positive consumption rate, AND
  //   - days actually passed since lastSyncDate.
  // For the false→true transition, we explicitly do NOT deduct
  // retroactively for the frozen period — currentPills stays unchanged.
  if (wasActive && !newState && med.dailyDose > 0 && daysPassed > 0) {
    pillsDeducted = Math.min(med.currentPills, daysPassed * med.dailyDose);
    settledPills = Math.max(0, med.currentPills - pillsDeducted);
  }

  const updatedMed: Medication = {
    ...med,
    currentPills: settledPills,
    lastSyncDate: todayStr,
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
          description: `تسوية عند إيقاف الخصم التلقائي: خصم ${daysPassed} ${daysPassed === 1 ? 'يوم' : 'أيام'} بالجرعة الحالية (${med.dailyDose}/يوم) (-${pillsDeducted} ${med.unit})`,
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

/**
 * Compute a stable transition key for a medication's critical-stock state.
 *
 * The key identifies a SPECIFIC critical transition — not merely "the med
 * is critical." It must:
 * - Stay stable across re-renders / app restarts for the same transition.
 * - Change when the med leaves critical state and later re-enters it.
 * - Not depend on dynamic pill counts (which fluctuate daily with auto-deduct).
 *
 * The key is derived from the threshold-crossing date: the UTC calendar date
 * on which the med's projected balance reaches the user-configured threshold.
 * This date is computed from lastSyncDate + effective balance, so it's
 * deterministic and doesn't shift as days pass (only changes on refill/consume/
 * dose/threshold edits, which legitimately create a new transition).
 *
 * Returns null for sufficient meds (no critical transition).
 */
export function getCriticalTransitionKey(
  med: Medication,
  todayStr: string = getTodayDateString()
): string | null {
  if (med.dailyDose <= 0) return null;

  const thresholdDays = getCriticalThresholdDays(med);
  const daysLeft = effectiveDaysLeft(med, todayStr);

  if (daysLeft > thresholdDays) return null; // sufficient

  // The med is critical or out_of_stock.
  // Compute the threshold-crossing date from lastSyncDate + effective balance.
  // This date is stable: it doesn't change as days pass (only changes when
  // the user refills, consumes, changes dose, or changes threshold).
  const effPills = effectiveCurrentPills(med, todayStr);
  const lastSyncUtc = parseUtcDate(med.lastSyncDate);
  if (!lastSyncUtc) return `${med.id}:unknown`;

  const totalDaysToDepletion = Math.max(0, effPills) / med.dailyDose;
  const daysToThreshold = totalDaysToDepletion - thresholdDays;
  const crossingUtcMs = lastSyncUtc.getTime() + Math.floor(daysToThreshold) * MS_PER_DAY;
  const crossingUtcDate = new Date(crossingUtcMs);
  const crossingDateStr = `${crossingUtcDate.getUTCFullYear()}-${String(crossingUtcDate.getUTCMonth() + 1).padStart(2, '0')}-${String(crossingUtcDate.getUTCDate()).padStart(2, '0')}`;

  return `${med.id}:${crossingDateStr}:${thresholdDays}`;
}
