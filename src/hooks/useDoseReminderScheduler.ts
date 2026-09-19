import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  cancelSnoozedDoseReminder,
  isDoseReminderPending,
  isNativeDoseReminderReArmed,
  isDoseReminderTimeStillAhead,
  doseReminderAlarmIdForDose,
  cancelStaleDoseReminderAlarms,
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
  /**
   * Bumped by App.tsx on EVERY app state transition (foreground ↔
   * background). Drives the main scheduling effect to re-arm all
   * pending dose reminders on the correct channel: silent foreground
   * channel when the app is open, system-sound background channel when
   * the app is backgrounded/killed. This is separate from resumeTick
   * (which is foreground-only and drives the consumption effect).
   */
  lifecycleTick?: number;
}

/**
 * One schedulable dose slot derived from explicit `doseSchedule` row.
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
  if (idx < 0) return { medId: key, doseId: '' };
  return { medId: key.slice(0, idx), doseId: key.slice(idx + 2) };
}

/**
 * Build dose reminder slots from explicit `doseSchedule` only.
 * Missing/empty schedule → []. No dailyDose/reminderTime synthetic slot.
 */
export function getDoseReminderSlots(med: Medication): DoseReminderSlot[] {
  const name = med.name;
  const unit = med.unit || 'قرص';
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const slots: DoseReminderSlot[] = [];
  for (const d of med.doseSchedule) {
    if (!d || !isValidDoseTime(d.time) || !(Number(d.amount) > 0)) continue;
    const doseId = typeof d.id === 'string' ? d.id.trim() : '';
    if (!doseId) continue;
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

/**
 * Native recurring daily dose-reminder scheduler.
 *
 * Phase 2: for each medication with `reminderEnabled`, schedules one
 * RECURRING daily notification per dose slot (multi-dose `doseSchedule`,
 * Each slot uses a stable
 * notification id derived from medicationId + doseId.
 *
 * The recurring alarm is config-driven. Consumption suppression still
 * uses per-dose consumption (`doseConsumption`).
 * skipToday applies only to slots consumed today.
 *
 * Generation counter + per-key serialization chain prevent races when
 * config changes quickly or resume reconciliation overlaps a schedule op.
 *
 * Lifecycle / hydration / resume re-runs are idempotent: unchanged dose
 * signatures with a still-pending native id are left untouched. Daily
 * recurrence after delivery is owned only by TimedNotificationPublisher
 * (initial one-shot LocalNotifications.schedule + next calendar-day arm
 * from extra.reminderTime; evidence in DoseReminderRecurrenceStore).
 * Stale native pending ids (process death) are cancelled via getPending()
 * against the desired set.
 */
export function useDoseReminderScheduler({
  medications,
  notificationsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmEnabled,
  resumeTick,
  lifecycleTick,
}: UseDoseReminderSchedulerOptions): void {
  const medicationsRef = useRef(medications);
  medicationsRef.current = medications;

  /** Keys currently believed scheduled: `${medId}::${doseId}`. */
  const scheduledDoseIdsRef = useRef<Set<string>>(new Set());
  /** Per-key generation counters — stale async ops no-op when gen mismatches. */
  const doseGenerationRef = useRef<Map<string, number>>(new Map());
  /** Per-key promise chain so cancel→schedule for one slot never interleaves. */
  const doseChainRef = useRef<Map<string, Promise<void>>>(new Map());
  /**
   * Last applied schedule signature per dose key (time|amount|name|skip|auto).
   * When equal and the native pending id is present, reconciliation is a no-op.
   */
  const appliedSignatureRef = useRef<Map<string, string>>(new Map());

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
            m.autoDeductEnabled !== false ? '1' : '0',
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
      appliedSignatureRef.current.delete(key);
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
      appliedSignatureRef.current.clear();
      return;
    }

    const stillScheduled = new Set<string>();
    const keepNativeIds = new Set<number>();
    const today = getTodayDateString();

    type DesiredSlot = {
      key: string;
      medId: string;
      doseId: string;
      time: string;
      amount: number;
      name: string;
      unit: string;
      slotConsumedToday: boolean;
      isAutoActive: boolean;
      sig: string;
    };
    const desired: DesiredSlot[] = [];

    // Build desired set from medication data (source of config truth).
    for (const med of medicationsRef.current) {
      if (!med.reminderEnabled) continue;
      const slots = getDoseReminderSlots(med);
      if (slots.length === 0) continue;

      for (const slot of slots) {
        const key = doseScheduleKey(slot.medId, slot.doseId);
        const slotConsumedToday = isDoseConsumedOnDate(med, slot.doseId, today);
        const isAutoActive = med.autoDeductEnabled !== false;
        const sig = [
          slot.time,
          String(slot.amount),
          slot.name,
          slot.unit,
          slotConsumedToday ? '1' : '0',
          isAutoActive ? '1' : '0',
        ].join('|');
        stillScheduled.add(key);
        const nid = doseReminderAlarmIdForDose(slot.medId, slot.doseId);
        if (nid != null) keepNativeIds.add(nid);
        desired.push({
          key,
          medId: slot.medId,
          doseId: slot.doseId,
          time: slot.time,
          amount: slot.amount,
          name: slot.name,
          unit: slot.unit,
          slotConsumedToday,
          isAutoActive,
          sig,
        });
      }
    }

    // Persisted native pending is authority for stale cleanup after process death.
    enqueue('__stale_dose_alarm_cleanup__', () =>
      cancelStaleDoseReminderAlarms(keepNativeIds)
    );

    // Reconcile each desired slot. Same signature + pending → no-op.
    // Missing pending → schedule one-shot (native owns next-day recurrence).
    // Signature change → cancel + one replacement.
    for (const slot of desired) {
      const {
        key,
        medId,
        doseId,
        time,
        amount,
        name,
        unit,
        slotConsumedToday,
        isAutoActive,
        sig,
      } = slot;
      const prevSig = appliedSignatureRef.current.get(key);
      if (prevSig === sig) {
        const gen = bumpGen(key);
        enqueue(key, async () => {
          if (doseGenerationRef.current.get(key) !== gen) return;
          // Reconciliation when signature is unchanged:
          //   A) pending=true → no-op
          //   B) pending=false + valid native re-arm for this occurrence identity
          //      (DoseReminderRecurrenceStore: future + matching reminderTime)
          //      → no-op (delivery transition; TimedNotificationPublisher owns next day)
          //   C) pending=false + no/stale re-arm evidence → one repair schedule
          //   D) expired or config-mismatched re-arm → treated as absent (repair)
          // Store is temporary delivery evidence, not proof AlarmManager still holds the alarm.
          const pending = await isDoseReminderPending(medId, doseId);
          if (doseGenerationRef.current.get(key) !== gen) return;
          if (pending) return;
          const nativeReArmed = await isNativeDoseReminderReArmed(
            medId,
            doseId,
            time
          );
          if (doseGenerationRef.current.get(key) !== gen) return;
          if (nativeReArmed) return;
          const opts = {
            ...(slotConsumedToday ? { skipToday: true as const } : {}),
            ...(isAutoActive ? { autoDeductEnabled: true } : {}),
          };
          await scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts);
          if (doseGenerationRef.current.get(key) !== gen) {
            await cancelDoseReminder(medId, doseId);
            return;
          }
          appliedSignatureRef.current.set(key, sig);
        });
        continue;
      }

      const gen = bumpGen(key);
      enqueue(key, () =>
        cancelDoseReminder(medId, doseId).then(async () => {
          if (doseGenerationRef.current.get(key) !== gen) return;
          const opts = {
            ...(slotConsumedToday ? { skipToday: true as const } : {}),
            ...(isAutoActive ? { autoDeductEnabled: true } : {}),
          };
          await scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts);
          if (doseGenerationRef.current.get(key) !== gen) {
            await cancelDoseReminder(medId, doseId);
            return;
          }
          appliedSignatureRef.current.set(key, sig);
        })
      );
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
    lifecycleTick,
  ]);

  // ─────────────────────────────────────────────────────────────
  // Consumption / restore reconciliation effect.
  //
  // Consume path: today's dose was taken → suppress today's reminder
  // (cancel + re-arm with skipToday) when the time is still ahead.
  //
  // Restore path: a previously consumed dose is cleared → if its
  // scheduled time is still ahead today, re-arm WITHOUT skipToday so
  // today's occurrence fires again. Only slots that transition from
  // consumed → not-consumed are re-armed (tracked via prevConsumedKeysRef)
  // so cold-start / config scheduling remains owned by the main effect.
  //
  // Per-dose identity is always medId + doseId; siblings are independent.
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

  /** Keys (medId::doseId) that were consumed on the last reconciliation. */
  const prevConsumedKeysRef = useRef<Set<string>>(new Set());
  /** Previous resumeTick — resume forces full re-suppress of still-consumed slots. */
  const prevResumeTickRef = useRef<number | null>(null);

  const resumeTickValue = resumeTick ?? 0;

  useEffect(() => {
    if (!hydrated || isFirstRun) return;
    if (!notificationsEnabled || exactAlarmEnabled !== true) return;

    const today = getTodayDateString();
    const nextConsumedKeys = new Set<string>();
    // Resume (or first observation of resumeTick) re-applies suppression for
    // every still-consumed slot. Signature-only changes process transitions
    // only so restoring d2 does not re-touch a still-consumed sibling d1.
    const resumeChanged =
      prevResumeTickRef.current === null ||
      prevResumeTickRef.current !== resumeTickValue;
    prevResumeTickRef.current = resumeTickValue;

    for (const med of medicationsRef.current) {
      if (!med.reminderEnabled) continue;

      const slots = getDoseReminderSlots(med);
      if (slots.length === 0) continue;

      for (const slot of slots) {
        const slotConsumedToday = isDoseConsumedOnDate(med, slot.doseId, today);
        const key = doseScheduleKey(slot.medId, slot.doseId);
        const { medId, doseId, time, amount, name, unit } = slot;
        const wasConsumed = prevConsumedKeysRef.current.has(key);

        if (slotConsumedToday) {
          nextConsumedKeys.add(key);
          // Suppress only when newly consumed, or when resume forces a full
          // re-apply. Still-consumed siblings must not be cancelled/rescheduled
          // merely because a different dose was restored.
          const newlyConsumed = !wasConsumed;
          if (!newlyConsumed && !resumeChanged) {
            continue;
          }
          clearSnoozedDose(med.id, doseId);
          const gen = bumpGen(key);
          enqueue(key, () =>
            cancelSnoozedDoseReminder(medId, doseId).then(() => {
              // After today's reminder time the recurring alarm has already
              // fired (or was suppressed): never retract a fired
              // notification. Only slots still ahead need cancel +
              // skipToday re-arm.
              if (!isDoseReminderTimeStillAhead(time)) return;
              return cancelDoseReminder(medId, doseId).then(() => {
                if (doseGenerationRef.current.get(key) !== gen) return;
                const isAutoActive = med.autoDeductEnabled !== false;
                const opts = {
                  skipToday: true as const,
                  ...(isAutoActive ? { autoDeductEnabled: true } : {}),
                };
                return scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts).then(
                  () => {
                    if (doseGenerationRef.current.get(key) !== gen) {
                      return cancelDoseReminder(medId, doseId);
                    }
                  }
                );
              });
            })
          );
        } else if (wasConsumed && isDoseReminderTimeStillAhead(time)) {
          // Restore transition: this slot was consumed on the previous
          // reconciliation and is no longer consumed, with today's time
          // still ahead → re-arm without skipToday (exact dose identity).
          // Past-due restored slots are intentionally skipped (no fabricated
          // past reminder). Cold start / never-consumed slots are left to
          // the main config effect.
          const gen = bumpGen(key);
          enqueue(key, () =>
            cancelDoseReminder(medId, doseId).then(() => {
              if (doseGenerationRef.current.get(key) !== gen) return;
              const isAutoActive = med.autoDeductEnabled !== false;
              const opts = {
                ...(isAutoActive ? { autoDeductEnabled: true } : {}),
              };
              return scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts).then(() => {
                if (doseGenerationRef.current.get(key) !== gen) {
                  return cancelDoseReminder(medId, doseId);
                }
              });
            })
          );
        }
      }
    }

    prevConsumedKeysRef.current = nextConsumedKeys;
  }, [
    consumedSignature,
    resumeTickValue,
    notificationsEnabled,
    exactAlarmEnabled,
    hydrated,
    isFirstRun,
  ]);
}
