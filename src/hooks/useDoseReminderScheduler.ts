import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import type { ExactAlarmPermission } from '../utils/exactAlarm';
import {
  getTodayDateString,
  isDoseConsumedOnDate,
} from '../utils/dateCalculations';
import {
  getMedicationTreatmentEndDate,
  isMedicationTreatmentActiveOnDate,
} from '../utils/medicationTreatment';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  isDoseReminderPending,
  isNativeDoseReminderReArmed,
  isDoseReminderTimeStillAhead,
  cancelStaleDoseReminderAlarms,
} from '../utils/doseReminderScheduling';
import { cancelSnoozedDoseReminder } from '../utils/notifications/doseReminderNotifications';
import { clearSnoozedDose } from '../utils/doseReminderStorage';
import {
  doseScheduleKey,
  parseDoseScheduleKey,
  getDoseReminderSlots,
  type DoseReminderSlot,
} from '../utils/doseReminderDefinitions';
import {
  bumpDoseReminderScheduleGeneration,
  isCurrentDoseReminderScheduleGeneration,
  enqueueDoseReminderScheduleOpGuarded,
  bumpDoseReminderSnoozeGeneration,
  isCurrentDoseReminderSnoozeGeneration,
  enqueueDoseReminderSnoozeOpGuarded,
  doseReminderSnoozeKey,
} from '../utils/doseReminderOperations';
export {
  doseScheduleKey,
  parseDoseScheduleKey,
  getDoseReminderSlots,
};
export type { DoseReminderSlot };

/**
 * Options for {@link useDoseReminderScheduler}.
 */
export interface UseDoseReminderSchedulerOptions {
  medications: Medication[];
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
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
  exactAlarmPermission: ExactAlarmPermission | null;
  /**
   * Bumped by App.tsx on every app resume (appStateChange) and on mount
   * it simply runs — drives the consumption-suppression reconciliation:
   * after a cold start or a resume, an already-consumed dose occurrence
   * (per-dose doseConsumptionHistory for medId + doseId on today) can
   * never produce TODAY's reminder, even if a previous suppression attempt
   * failed (bridge error, the process being killed mid-operation).
   * Medication-level lastConsumedDate is not the source of truth here.
   * Mirrors the critical-alarm scheduler's resumeTick pattern.
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
 * Native Dose Reminder scheduler.
 *
 * For each medication with `reminderEnabled`, schedules one exact one-shot
 * alarm per explicit `doseSchedule` row. Each slot uses the stable
 * medicationId + doseId identity.
 *
 * Exact timing, native identity, durable alarm metadata, cancellation,
 * ordering, timezone/boot recovery, and exact-alarm permission are owned by
 * the shared ExactAlarmRuntime through the native Dose Reminder adapter.
 * Dose Reminder owns the feature policy: consumption suppression,
 * `skipToday`, daily recurrence, foreground/background notification channel
 * selection, and the business-provided `allowManualTakeAction` capability.
 *
 * Generation counter + per-key serialization chain prevent races when
 * config changes quickly or resume reconciliation overlaps a schedule op.
 *
 * Lifecycle / hydration / resume re-runs are idempotent: unchanged dose
 * signatures with a still-pending native alarm are left untouched. When a
 * delivery occurs, DoseReminderAlarmReceiver owns the feature-specific
 * next-calendar-day re-arm through the shared ExactAlarmRuntime.
 * Stale native pending alarms are cancelled against the
 * desired set.
 */
export function useDoseReminderScheduler({
  medications,
  allowManualTakeActionByMedicationId,
  notificationsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmPermission,
  resumeTick,
  lifecycleTick,
}: UseDoseReminderSchedulerOptions): void {
  const medicationsRef = useRef(medications);
  medicationsRef.current = medications;
  /** Keys currently believed scheduled: `${medId}::${doseId}`. */
  const scheduledDoseIdsRef = useRef<Set<string>>(new Set());
  /** Retry timers are local lifecycle state; operation ownership is feature-shared. */
  /**
   * Last applied schedule signature per dose key (time|amount|name|skip|manual-action).
   * When equal and the native pending id is present, reconciliation is a no-op.
   */
  const appliedSignatureRef = useRef<Map<string, string>>(new Map());
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const retryAttemptsRef = useRef<Map<string, number>>(new Map());
  const retryGenerationRef = useRef(0);

  const clearRetry = (key: string): void => {
    const timer = retryTimersRef.current.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      retryTimersRef.current.delete(key);
    }
    retryAttemptsRef.current.delete(key);
  };

  const enqueueRetryable = (
    retryKey: string,
    operationKey: string,
    generation: number,
    enqueue: (
      key: string,
      generation: number,
      operation: () => Promise<void>
    ) => Promise<void>,
    isCurrent: (key: string, generation: number) => boolean,
    operation: () => Promise<void>
  ): void => {
    clearRetry(retryKey);

    const run = (attempt: number): Promise<void> =>
      enqueue(operationKey, generation, async () => {
        if (!isCurrent(operationKey, generation)) return;
        try {
          await operation();
          clearRetry(retryKey);
        } catch (error) {
          if (!isCurrent(operationKey, generation)) return;
          const nextAttempt = attempt + 1;
          if (nextAttempt > 3) {
            console.warn(
              '[dose-reminder] bounded retry exhausted:',
              operationKey,
              error
            );
            return;
          }
          const delays = [1000, 4000, 16000] as const;
          const timer = setTimeout(() => {
            retryTimersRef.current.delete(retryKey);
            if (!isCurrent(operationKey, generation)) return;
            void run(nextAttempt);
          }, delays[attempt]);
          retryTimersRef.current.set(retryKey, timer);
          retryAttemptsRef.current.set(retryKey, nextAttempt);
        }
      });

    void run(0);
  };

  const clearAllRetries = (): void => {
    for (const key of retryTimersRef.current.keys()) {
      clearRetry(key);
    }
    retryTimersRef.current.clear();
    retryAttemptsRef.current.clear();
  };

  const cancelSnoozeSlot = (medId: string, doseId: string): void => {
    const scheduleKey = doseScheduleKey(medId, doseId);
    const operationKey = doseReminderSnoozeKey(medId, doseId);
    const generation =
      bumpDoseReminderSnoozeGeneration(operationKey);
    enqueueRetryable(
      'snooze:' + scheduleKey,
      operationKey,
      generation,
      enqueueDoseReminderSnoozeOpGuarded,
      isCurrentDoseReminderSnoozeGeneration,
      async () => {
        await cancelSnoozedDoseReminder(medId, doseId);
        clearSnoozedDose(medId, doseId);
      }
    );
  };

  const doseSignature = useMemo(
    () =>
      medications
        .map((m) => {
          const schedulePart =
            Array.isArray(m.doseSchedule) && m.doseSchedule.length > 0
              ? m.doseSchedule
                  .map((d) => `${d.id}@${d.time}@${d.amount}@${typeof d.description === 'string' ? d.description.trim() : ''}`)
                  .join(',')
              : '';
          // Reminder slots from explicit doseSchedule only.
          // reminderTime/dailyDose are not separate sources of dose identity.
          return [
            m.id,
            m.reminderEnabled === true ? '1' : '0',
            m.isChronic === false ? 'temporary' : 'chronic',
            getMedicationTreatmentEndDate(m) ?? '',
            m.treatmentStartDate ?? '',
            schedulePart,
            m.name,
            m.unit ?? '',
            (allowManualTakeActionByMedicationId.get(m.id) ?? true) ? '1' : '0',
          ].join('|');
        })
        .sort()
        .join('\n'),
    [medications, allowManualTakeActionByMedicationId]
  );
  useEffect(() => {
    if (!hydrated || isFirstRun) return;
    const cancelSlot = (medId: string, doseId: string): void => {
      const key = doseScheduleKey(medId, doseId);
      const gen = bumpDoseReminderScheduleGeneration(key);
      appliedSignatureRef.current.delete(key);
      clearRetry('schedule:' + key);

      enqueueRetryable(
        'schedule:' + key,
        key,
        gen,
        enqueueDoseReminderScheduleOpGuarded,
        isCurrentDoseReminderScheduleGeneration,
        async () => {
          await cancelDoseReminder(medId, doseId);
        }
      );

      cancelSnoozeSlot(medId, doseId);
    };
    // User disabled notifications OR exact-alarm permission is missing →
    // cancel all previously-scheduled dose reminders and clear the tracker.
    if (!notificationsEnabled || exactAlarmPermission === null || exactAlarmPermission === 'denied') {
      scheduledDoseIdsRef.current.forEach((key) => {
        const { medId, doseId } = parseDoseScheduleKey(key);
        cancelSlot(medId, doseId);
      });

      const staleGeneration = ++retryGenerationRef.current;
      clearRetry('__stale_dose_alarm_cleanup__');
      const retryStaleCleanup = async (attempt: number): Promise<void> => {
        if (retryGenerationRef.current !== staleGeneration) return;
        const result = await cancelStaleDoseReminderAlarms(new Set());
        if (result.ok) {
          clearRetry('__stale_dose_alarm_cleanup__');
          return;
        }
        if (attempt >= 3) {
          console.warn(
            '[dose-reminder] bounded stale-alarm cleanup retry exhausted:',
            result.error,
            result.errorCode
          );
          return;
        }
        const delays = [1000, 4000, 16000] as const;
        const timer = setTimeout(() => {
          retryTimersRef.current.delete('__stale_dose_alarm_cleanup__');
          void retryStaleCleanup(attempt + 1);
        }, delays[attempt]);
        retryTimersRef.current.set(
          '__stale_dose_alarm_cleanup__',
          timer
        );
      };
      void retryStaleCleanup(0);

      scheduledDoseIdsRef.current.clear();
      appliedSignatureRef.current.clear();
      return;
    }
    const stillScheduled = new Set<string>();
    const keepNativeIds = new Set<string>();
    const today = getTodayDateString();
    type DesiredSlot = {
      key: string;
      medId: string;
      doseId: string;
      time: string;
      amount: number;
      name: string;
      unit: string;
      description?: string;
      slotConsumedToday: boolean;
      allowManualTakeAction: boolean;
      treatmentEndDate?: string;
      sig: string;
    };
    const desired: DesiredSlot[] = [];
    // Build desired set from medication data (source of config truth).
    for (const med of medicationsRef.current) {
      if (!med.reminderEnabled) continue;
      if (!isMedicationTreatmentActiveOnDate(med, today)) continue;
      const treatmentEndDate = getMedicationTreatmentEndDate(med);
      const slots = getDoseReminderSlots(med);
      if (slots.length === 0) continue;
      for (const slot of slots) {
        const key = doseScheduleKey(slot.medId, slot.doseId);
        const slotConsumedToday = isDoseConsumedOnDate(med, slot.doseId, today);
        const allowManualTakeAction = allowManualTakeActionByMedicationId.get(med.id) ?? true;
        const sig = [
          slot.time,
          String(slot.amount),
          slot.name,
          slot.unit,
          slot.description ?? '',
          slotConsumedToday ? '1' : '0',
          allowManualTakeAction ? '1' : '0',
          treatmentEndDate ?? '',
        ].join('|');
        stillScheduled.add(key);
        keepNativeIds.add(key);
        desired.push({
          key,
          medId: slot.medId,
          doseId: slot.doseId,
          time: slot.time,
          amount: slot.amount,
          name: slot.name,
          unit: slot.unit,
          description: slot.description,
          slotConsumedToday,
          allowManualTakeAction,
          treatmentEndDate,
          sig,
        });
      }
    }
    // Persisted native schedule state is the authority for stale cleanup after
    // process death. A failed native read must never be interpreted as empty.
    const staleGeneration = ++retryGenerationRef.current;
    clearRetry('__stale_dose_alarm_cleanup__');
    const retryStaleCleanup = async (attempt: number): Promise<void> => {
      if (retryGenerationRef.current !== staleGeneration) return;
      const result = await cancelStaleDoseReminderAlarms(keepNativeIds);
      if (result.ok) {
        clearRetry('__stale_dose_alarm_cleanup__');
        return;
      }
      if (attempt >= 3) {
        console.warn(
          '[dose-reminder] bounded stale-alarm cleanup retry exhausted:',
          result.error,
          result.errorCode
        );
        return;
      }
      const delays = [1000, 4000, 16000] as const;
      const timer = setTimeout(() => {
        retryTimersRef.current.delete('__stale_dose_alarm_cleanup__');
        void retryStaleCleanup(attempt + 1);
      }, delays[attempt]);
      retryTimersRef.current.set(
        '__stale_dose_alarm_cleanup__',
        timer
      );
    };
      void retryStaleCleanup(0);
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
        description,
        slotConsumedToday,
        allowManualTakeAction,
        treatmentEndDate,
        sig,
      } = slot;
      const prevSig = appliedSignatureRef.current.get(key);
      if (prevSig === sig) {
        const gen = bumpDoseReminderScheduleGeneration(key);
        enqueueRetryable(
        'schedule:' + key,
        key,
        gen,
        enqueueDoseReminderScheduleOpGuarded,
        isCurrentDoseReminderScheduleGeneration,
        async () => {
          if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
          // Reconciliation when signature is unchanged:
          //   A) pending=true → no-op
          //   B) pending=false + native delivery transition already re-armed the
          //      successor occurrence for this dose identity → no-op
          //   C) pending=false + no valid native re-arm → one repair schedule
          //   D) expired or config-mismatched native state → treated as absent
          //      and repaired
          // The native pending state is the scheduling authority; there is no
          // separate recurrence-evidence store.
          const pendingResult = await isDoseReminderPending(medId, doseId);
          if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
          if (!pendingResult.ok) {
            throw new Error(
              pendingResult.error || 'dose_reminder_pending_lookup_failed'
            );
          }
          if (pendingResult.pending) return;
          const nativeReArmed = await isNativeDoseReminderReArmed(
            medId,
            doseId,
            time
          );
          if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
          if (!nativeReArmed.ok) {
            throw new Error(
              nativeReArmed.error || 'dose_reminder_rearm_lookup_failed'
            );
          }
          if (nativeReArmed.scheduled) return;
          const opts = {
            ...(slotConsumedToday ? { skipToday: true as const } : {}),
            allowManualTakeAction,
            ...(description ? { doseDescription: description } : {}),
            ...(treatmentEndDate ? { treatmentEndDate } : {}),
          };
          await scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts);
          if (!isCurrentDoseReminderScheduleGeneration(key, gen)) {
            await cancelDoseReminder(medId, doseId);
            return;
          }
          appliedSignatureRef.current.set(key, sig);
        });
        continue;
      }
      cancelSnoozeSlot(medId, doseId);

      const gen = bumpDoseReminderScheduleGeneration(key);
      enqueueRetryable(
        'schedule:' + key,
        key,
        gen,
        enqueueDoseReminderScheduleOpGuarded,
        isCurrentDoseReminderScheduleGeneration,
        async () => {
        if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
        await cancelDoseReminder(medId, doseId);
        if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
        const opts = {
          ...(slotConsumedToday ? { skipToday: true as const } : {}),
          allowManualTakeAction,
          ...(description ? { doseDescription: description } : {}),
          ...(treatmentEndDate ? { treatmentEndDate } : {}),
        };
        await scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts);
        if (!isCurrentDoseReminderScheduleGeneration(key, gen)) {
          await cancelDoseReminder(medId, doseId);
          return;
        }
        appliedSignatureRef.current.set(key, sig);
      });
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
    exactAlarmPermission,
    hydrated,
    isFirstRun,
    lifecycleTick,
  ]);
  useEffect(() => () => {
    clearAllRetries();
    retryGenerationRef.current += 1;
  }, []);

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
          const perDose = m.doseConsumptionHistory
            ? Object.entries(m.doseConsumptionHistory)
                .map(([id, d]) => `${id}=${Array.isArray(d) ? d.join('|') : d}`)
                .sort()
                .join(',')
            : '';
          // Per-dose consumption only; medication-level lastConsumedDate
          // is not a reminder reconciliation dependency.
          return `${m.id}|${perDose}`;
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
    if (!notificationsEnabled || exactAlarmPermission === null || exactAlarmPermission === 'denied') return;
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
      if (!isMedicationTreatmentActiveOnDate(med, today)) continue;
      const treatmentEndDate = getMedicationTreatmentEndDate(med);
      const slots = getDoseReminderSlots(med);
      if (slots.length === 0) continue;
      for (const slot of slots) {
        const slotConsumedToday = isDoseConsumedOnDate(med, slot.doseId, today);
        const key = doseScheduleKey(slot.medId, slot.doseId);
        const { medId, doseId, time, amount, name, unit, description } = slot;
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
          cancelSnoozeSlot(medId, doseId);

          const gen = bumpDoseReminderScheduleGeneration(key);
          enqueueRetryable(
            'schedule:' + key,
            key,
            gen,
            enqueueDoseReminderScheduleOpGuarded,
            isCurrentDoseReminderScheduleGeneration,
            async () => {
            // After today's reminder time the recurring alarm has already
            // fired (or was suppressed): never retract a fired
            // notification. Only slots still ahead need cancel +
            // skipToday re-arm.
            if (!isDoseReminderTimeStillAhead(time)) {
              const pendingResult = await isDoseReminderPending(medId, doseId);
              if (!pendingResult.ok) {
                throw new Error(
                  pendingResult.error || 'dose_reminder_pending_lookup_failed'
                );
              }
              if (!pendingResult.pending) {
                return;
              }
            }
            if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
            await cancelDoseReminder(medId, doseId);
            if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
            const allowManualTakeAction = allowManualTakeActionByMedicationId.get(med.id) ?? true;
            const opts = {
              skipToday: true as const,
              allowManualTakeAction,
              ...(description ? { doseDescription: description } : {}),
              ...(treatmentEndDate ? { treatmentEndDate } : {}),
            };
            await scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts);
            if (!isCurrentDoseReminderScheduleGeneration(key, gen)) {
              await cancelDoseReminder(medId, doseId);
              return;
            }
          });
        } else if (wasConsumed && isDoseReminderTimeStillAhead(time)) {
          // Restore transition: this slot was consumed on the previous
          // reconciliation and is no longer consumed, with today's time
          // still ahead → re-arm without skipToday (exact dose identity).
          // Past-due restored slots are intentionally skipped (no fabricated
          // past reminder). Cold start / never-consumed slots are left to
          // the main config effect.
          cancelSnoozeSlot(medId, doseId);

          const gen = bumpDoseReminderScheduleGeneration(key);
          enqueueRetryable(
        'schedule:' + key,
        key,
        gen,
        enqueueDoseReminderScheduleOpGuarded,
        isCurrentDoseReminderScheduleGeneration,
        async () => {
            await cancelDoseReminder(medId, doseId);
            if (!isCurrentDoseReminderScheduleGeneration(key, gen)) return;
            const allowManualTakeAction = allowManualTakeActionByMedicationId.get(med.id) ?? true;
            const opts = {
              allowManualTakeAction,
              ...(description ? { doseDescription: description } : {}),
              ...(treatmentEndDate ? { treatmentEndDate } : {}),
            };
            await scheduleDoseReminder(medId, name, time, amount, unit, doseId, opts);
            if (!isCurrentDoseReminderScheduleGeneration(key, gen)) {
              await cancelDoseReminder(medId, doseId);
            }
          });
        }
      }
    }
    prevConsumedKeysRef.current = nextConsumedKeys;
  }, [
    consumedSignature,
    resumeTickValue,
    notificationsEnabled,
    exactAlarmPermission,
    hydrated,
    isFirstRun,
    allowManualTakeActionByMedicationId,
  ]);
}