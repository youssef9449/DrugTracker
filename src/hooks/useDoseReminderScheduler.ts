import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  cancelSnoozedDoseReminder,
  isDoseReminderTimeStillAhead,
  LEGACY_DOSE_ID,
} from '../utils/notifications';
import { clearSnoozedDose } from '../utils/doseReminderStorage';
import { isValidDoseTime } from '../utils/doseSchedule';
import { isDoseConsumedOnDate } from '../utils/dateCalculations';

/**
 * Options for {@link useDoseReminderScheduler}.
 */
export interface UseDoseReminderSchedulerOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  /**
   * Whether exact-alarm permission is granted on Android 12+. When null,
   * the permission has not been checked yet (no scheduling). When false,
   * the scheduler does NOT schedule dose reminders (they would be inexact
   * and fire at unpredictable times — unacceptable for medication
   * reminders). When true, scheduling proceeds.
   *
   * On web / Android < 12 this is always true (no permission needed).
   */
  exactAlarmEnabled: boolean | null;
  /**
   * Bumped by App.tsx on every app resume (appStateChange) and on mount
   * it simply runs — drives the consumption-suppression reconciliation:
   * after a cold start or a resume, an already-consumed dose
   * (lastConsumedDate === today) can never produce TODAY's reminder,
   * even if a previous suppression attempt failed (bridge error, the
   * process being killed mid-operation). Mirrors the critical-alarm
   * scheduler's resumeTick pattern.
   */
  resumeTick?: number;
}

/**
 * One schedulable dose slot derived from a medication.
 * - Multi-dose meds: one entry per `doseSchedule` row (stable dose id).
 * - Legacy meds (no schedule): single entry with {@link LEGACY_DOSE_ID}.
 */
export interface DoseReminderSlot {
  medId: string;
  doseId: string;
  time: string;
  amount: number;
  name: string;
  unit: string;
}

/** Tracker key: medId::doseId — independent cancel/schedule identity. */
export function doseScheduleKey(medId: string, doseId: string): string {
  return `${medId}::${doseId}`;
}

export function parseDoseScheduleKey(key: string): { medId: string; doseId: string } {
  const idx = key.indexOf('::');
  if (idx < 0) return { medId: key, doseId: LEGACY_DOSE_ID };
  return { medId: key.slice(0, idx), doseId: key.slice(idx + 2) };
}

/**
 * Build the list of dose reminder slots for a medication.
 *
 * Source of truth for multi-dose: non-empty `doseSchedule` (by dose id).
 * Legacy: single slot at `reminderTime` with amount = `dailyDose`.
 * Invalid/missing times are skipped.
 *
 * Does not mutate the medication. Does not implement stock logic.
 */
export function getDoseReminderSlots(med: Medication): DoseReminderSlot[] {
  const name = med.name;
  const unit = med.unit || 'قرص';

  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
    // Skip invalid rows; keep first occurrence of each doseId (stable
    // identity — never let a duplicate row steal another slot's id).
    const seen = new Set<string>();
    const slots: DoseReminderSlot[] = [];
    for (const d of med.doseSchedule) {
      if (!d || !isValidDoseTime(d.time) || !(Number(d.amount) > 0)) continue;
      const doseId = (d.id && String(d.id).trim()) || LEGACY_DOSE_ID;
      if (seen.has(doseId)) continue;
      seen.add(doseId);
      slots.push({
        medId: med.id,
        doseId,
        time: d.time,
        amount: Number(d.amount),
        name,
        unit,
      });
    }
    return slots;
  }

  if (med.reminderTime && isValidDoseTime(med.reminderTime)) {
    return [
      {
        medId: med.id,
        doseId: LEGACY_DOSE_ID,
        time: med.reminderTime,
        amount: Number(med.dailyDose) > 0 ? Number(med.dailyDose) : 1,
        name,
        unit,
      },
    ];
  }

  return [];
}

/**
 * Native recurring daily dose-reminder scheduler.
 *
 * Phase 2: for each medication with `reminderEnabled`, schedules one
 * RECURRING daily notification per dose slot (multi-dose `doseSchedule`,
 * or a single legacy `reminderTime` slot). Each slot uses a stable
 * notification id derived from medicationId + doseId.
 *
 * The recurring alarm is config-driven. Consumption suppression still
 * uses per-dose consumption (`doseConsumption` / legacy lastConsumedDate).
 * skipToday applies only to slots consumed today.
 *
 * Generation counter + per-key serialization chain prevent races when
 * config changes quickly or resume reconciliation overlaps a schedule op.
 */
export function useDoseReminderScheduler({
  medications,
  notificationsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmEnabled,
  resumeTick,
}: UseDoseReminderSchedulerOptions): void {
  const medicationsRef = useRef(medications);
  medicationsRef.current = medications;

  /** Keys currently believed scheduled: `${medId}::${doseId}`. */
  const scheduledDoseIdsRef = useRef<Set<string>>(new Set());
  /** Per-key generation counters — stale async ops no-op when gen mismatches. */
  const doseGenerationRef = useRef<Map<string, number>>(new Map());
  /** Per-key promise chain so cancel→schedule for one slot never interleaves. */
  const doseChainRef = useRef<Map<string, Promise<void>>>(new Map());

  const doseSignature = useMemo(
    () =>
      medications
        .map((m) => {
          const schedulePart =
            Array.isArray(m.doseSchedule) && m.doseSchedule.length > 0
              ? m.doseSchedule
                  .map((d) => `${d.id}@${d.time}@${d.amount}`)
                  .join(',')
              : '';
          return [
            m.id,
            m.reminderEnabled === true ? '1' : '0',
            m.reminderTime ?? '',
            schedulePart,
            m.name,
            m.dailyDose,
            m.unit ?? '',
          ].join('|');
        })
        .sort()
        .join('\n'),
    [medications]
  );

  const enqueue = (key: string, op: () => Promise<void>): Promise<void> => {
    const prev = doseChainRef.current.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    doseChainRef.current.set(key, next);
    next.catch(() => void 0);
    return next;
  };

  const bumpGen = (key: string): number => {
    const gen = (doseGenerationRef.current.get(key) ?? 0) + 1;
    doseGenerationRef.current.set(key, gen);
    return gen;
  };

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    const cancelSlot = (medId: string, doseId: string): void => {
      const key = doseScheduleKey(medId, doseId);
      bumpGen(key);
      // Phase 4: clear dose-scoped snooze storage + cancel that slot's
      // recurring alarm and one-shot snooze (not sibling doses).
      clearSnoozedDose(medId, doseId);
      enqueue(key, () =>
        cancelDoseReminder(medId, doseId).then(() =>
          cancelSnoozedDoseReminder(medId, doseId)
        )
      );
    };

    // User disabled notifications OR exact-alarm permission is missing →
    // cancel all previously-scheduled dose reminders and clear the tracker.
    if (!notificationsEnabled || exactAlarmEnabled !== true) {
      scheduledDoseIdsRef.current.forEach((key) => {
        const { medId, doseId } = parseDoseScheduleKey(key);
        cancelSlot(medId, doseId);
      });
      scheduledDoseIdsRef.current.clear();
      return;
    }

    const stillScheduled = new Set<string>();

    for (const med of medicationsRef.current) {
      if (!med.reminderEnabled) {
        // Disable: cancel every previously scheduled slot for this med.
        for (const key of scheduledDoseIdsRef.current) {
          const { medId, doseId } = parseDoseScheduleKey(key);
          if (medId === med.id) {
            cancelSlot(medId, doseId);
          }
        }
        continue;
      }

      const slots = getDoseReminderSlots(med);
      if (slots.length === 0) {
        for (const key of scheduledDoseIdsRef.current) {
          const { medId, doseId } = parseDoseScheduleKey(key);
          if (medId === med.id) {
            cancelSlot(medId, doseId);
          }
        }
        continue;
      }

      const today = getTodayDateString();
      const activeDoseIds = new Set(slots.map((s) => s.doseId));

      // Cancel slots that were scheduled for this med but are no longer
      // in the current schedule (removed dose rows).
      for (const key of scheduledDoseIdsRef.current) {
        const { medId, doseId } = parseDoseScheduleKey(key);
        if (medId === med.id && !activeDoseIds.has(doseId)) {
          cancelSlot(medId, doseId);
        }
      }

      for (const slot of slots) {
        const key = doseScheduleKey(slot.medId, slot.doseId);
        const gen = bumpGen(key);
        const doseId = slot.doseId;
        const time = slot.time;
        const amount = slot.amount;
        const name = slot.name;
        const unit = slot.unit;
        const medId = slot.medId;
        // Phase 3: suppress only this dose slot when it was consumed today.
        const slotConsumedToday = isDoseConsumedOnDate(med, doseId, today);

        enqueue(key, () =>
          cancelDoseReminder(medId, doseId).then(() => {
            if (doseGenerationRef.current.get(key) !== gen) return;
            const opts =
              doseId === LEGACY_DOSE_ID
                ? slotConsumedToday
                  ? { skipToday: true as const }
                  : undefined
                : {
                    doseId,
                    ...(slotConsumedToday ? { skipToday: true as const } : {}),
                  };
            return (
              opts
                ? scheduleDoseReminder(medId, name, time, amount, unit, opts)
                : scheduleDoseReminder(medId, name, time, amount, unit)
            ).then(() => {
              if (doseGenerationRef.current.get(key) !== gen) {
                return cancelDoseReminder(medId, doseId);
              }
            });
          })
        );
        stillScheduled.add(key);
      }
    }

    for (const prevKey of scheduledDoseIdsRef.current) {
      if (!stillScheduled.has(prevKey)) {
        const { medId, doseId } = parseDoseScheduleKey(prevKey);
        cancelSlot(medId, doseId);
      }
    }
    scheduledDoseIdsRef.current = stillScheduled;
  }, [
    doseSignature,
    notificationsEnabled,
    exactAlarmEnabled,
    hydrated,
    isFirstRun,
  ]);

  // ─────────────────────────────────────────────────────────────
  // Consumption-suppression effect — today's dose was taken, so today's
  // reminders must not fire. Phase 2 still uses medication-level
  // lastConsumedDate: when set to today, EVERY dose slot for that med
  // is suppressed for today (skipToday re-arm). Per-dose consumption
  // state is Phase 3.
  // ─────────────────────────────────────────────────────────────
  const consumedSignature = useMemo(
    () =>
      medications
        .map((m) => {
          const perDose = m.doseConsumption
            ? Object.entries(m.doseConsumption)
                .map(([id, d]) => `${id}=${d}`)
                .sort()
                .join(',')
            : '';
          return `${m.id}|${m.lastConsumedDate ?? ''}|${perDose}`;
        })
        .sort()
        .join('\n'),
    [medications]
  );

  const resumeTickValue = resumeTick ?? 0;

  useEffect(() => {
    if (!hydrated || isFirstRun) return;
    if (!notificationsEnabled || exactAlarmEnabled !== true) return;

    const today = getTodayDateString();
    for (const med of medicationsRef.current) {
      if (!med.reminderEnabled) continue;

      const slots = getDoseReminderSlots(med);
      if (slots.length === 0) continue;

      // Only slots consumed today need suppression.
      const consumedSlots = slots.filter((s) =>
        isDoseConsumedOnDate(med, s.doseId, today)
      );
      if (consumedSlots.length === 0) continue;

      for (const slot of consumedSlots) {
        // Phase 3B: clear only this slot's snooze marker (med-only for legacy).
        clearSnoozedDose(med.id, slot.doseId);

        const key = doseScheduleKey(slot.medId, slot.doseId);
        const gen = bumpGen(key);
        const { medId, doseId, time, amount, name, unit } = slot;

        enqueue(key, () =>
          cancelSnoozedDoseReminder(medId, doseId).then(() => {
            // After today's reminder time for THIS slot, the recurring
            // alarm has already fired (or was suppressed): never retract
            // a fired notification. Only slots still ahead need cancel +
            // skipToday re-arm.
            if (!isDoseReminderTimeStillAhead(time)) return;
            return cancelDoseReminder(medId, doseId).then(() => {
              if (doseGenerationRef.current.get(key) !== gen) return;
              const opts =
                doseId === LEGACY_DOSE_ID
                  ? { skipToday: true as const }
                  : { doseId, skipToday: true as const };
              return scheduleDoseReminder(medId, name, time, amount, unit, opts).then(
                () => {
                  if (doseGenerationRef.current.get(key) !== gen) {
                    return cancelDoseReminder(medId, doseId);
                  }
                }
              );
            });
          })
        );
      }
    }
  }, [
    consumedSignature,
    resumeTickValue,
    notificationsEnabled,
    exactAlarmEnabled,
    hydrated,
    isFirstRun,
  ]);
}
