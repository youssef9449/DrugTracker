/**
 * JS-side scheduler for native exact-time auto-deduction.
 * Independent of notifications. Does NOT mutate currentPills / logs.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import type { ExactAlarmPermission } from '../utils/exactAlarm';
import { getTodayDateString, tomorrowDateString, localEpochMs } from '../utils/dateCalculations';
import {
  getMedicationTreatmentEndDate,
  isMedicationTreatmentActiveOnDate,
} from '../utils/medicationTreatment';
import { isValidDoseTime, normalizeTimeString } from '../utils/doseSchedule';
import {
  cancelAutoDeduction,
  invalidateAutoDeductionRecurrence,
  scheduleAutoDeduction,
  listScheduledAutoDeductionOccurrences,
  type ScheduledOccurrence,
} from '../utils/autoDeductionNative';
import {
  recoveryBoundaryKey,
  restoreFutureSchedulesOnce,
} from '../utils/restoreFutureSchedulesBoundary';
import { withAutoStockMutationGate } from '../utils/autoDeductionStockGate';
import { OperationQueue } from '../utils/async/OperationQueue';
import { GenerationGuard } from '../utils/async/GenerationGuard';
export interface UseAutoDeductionSchedulerOptions {
  medications: Medication[];
  globalAutoDeductEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  resumeTick?: number;
  /** Increments at each local-midnight rollover while the app stays open. */
  midnightTick?: number;
}
export interface AutoDeductionSlot {
  medId: string;
  doseId: string;
  time: string;
  amount: number;
  calendarDate: string;
  treatmentEndDate?: string;
}
export function autoDeductionScheduleKey(
  medId: string,
  doseId: string,
  calendarDate: string
): string {
  return `${medId}::${doseId}::${calendarDate}`;
}
export function getAutoDeductionSlotsForDate(
  med: Medication,
  calendarDate: string
): AutoDeductionSlot[] {
  if (med.autoDeductEnabled === false) return [];
  if (!isMedicationTreatmentActiveOnDate(med, calendarDate)) return [];
  const treatmentEndDate = getMedicationTreatmentEndDate(med);
  // Exact slots come only from explicit doseSchedule rows.
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const slots: AutoDeductionSlot[] = [];
  for (const d of med.doseSchedule) {
    if (!d || !isValidDoseTime(d.time) || !(Number(d.amount) > 0)) continue;
    const doseId = typeof d.id === 'string' ? d.id.trim() : '';
    if (!doseId) continue;
    if (seen.has(doseId)) continue;
    seen.add(doseId);
    slots.push({
      medId: med.id,
      doseId,
      time: normalizeTimeString(d.time),
      amount: Number(d.amount),
      calendarDate,
      treatmentEndDate: treatmentEndDate ?? undefined,
    });
  }
  return slots;
}
type GuardedCancelResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
};
/**
 * Native exact-schedule writes must serialize with stock/config mutations.
 * The request may have been built from an older React render, so the durable
 * medication is re-read while holding the same JS gate immediately before the
 * native write. A stale request therefore either linearizes before the config
 * mutation (and is then invalidated by that mutation) or runs after it and
 * uses the current durable configuration.
 */
async function scheduleExactOccurrenceFromDurable(slot: AutoDeductionSlot) {
  return withAutoStockMutationGate(async (fresh) => {
    // Medication-level Auto is authoritative (Global bulk-sets med flags; not a runtime kill switch).
    const med = fresh.medications.find((m) => m.id === slot.medId);
    if (!med) return { ok: true, skipped: true } as const;
    const current = getAutoDeductionSlotsForDate(med, slot.calendarDate).find(
      (candidate) => candidate.doseId === slot.doseId
    );
    if (!current) return { ok: true, skipped: true } as const;
    const epoch = localEpochMs(current.calendarDate, current.time);
    if (epoch == null || epoch <= Date.now() - 2000) {
      return { ok: true, skipped: true } as const;
    }
    // IMPORTANT: use the durable slot, not the stale React snapshot.
    return scheduleAutoDeduction({
      medicationId: current.medId,
      doseId: current.doseId,
      calendarDate: current.calendarDate,
      timeHhmm: current.time,
      amount: current.amount,
      scheduledAtEpochMs: epoch,
      treatmentEndDate: current.treatmentEndDate,
    });
  });
}
/**
 * Cancel a stale native exact occurrence under the same durable gate used by
 * stock/config mutations. For normal reconciliation cleanup, cancellation
 * is allowed only when the durable medication no longer desires this exact
 * occurrence. Otherwise a stale React scheduler pass must not invalidate or
 * cancel a newly committed schedule with the same identity.
 *
 * force=true is used only when exact-alarm permission is unavailable. In that
 * case native cancellation is policy-required even though the durable config
 * still desires the occurrence.
 */
async function cancelUndesiredExactOccurrence(
  medId: string,
  doseId: string,
  calendarDate: string,
  force = false
): Promise<GuardedCancelResult> {
  return withAutoStockMutationGate(async (fresh) => {
    const med = fresh.medications.find((m) => m.id === medId);
    // stillDesired depends on medication Auto + dose slot presence only.
    const stillDesired = !!med &&
      getAutoDeductionSlotsForDate(med, calendarDate).some(
        (slot) => slot.doseId === doseId
      );
    if (!force && stillDesired) {
      return { ok: true, skipped: true } as const;
    }
    if (!force) {
      const invalidation = await invalidateAutoDeductionRecurrence(medId, doseId);
      if (!invalidation.ok && invalidation.error !== 'not_android') {
        return { ok: false, error: invalidation.error ?? 'invalidate_failed' };
      }
    }
    const result = await cancelAutoDeduction(medId, doseId, calendarDate);
    return {
      ok: result.ok,
      error: result.ok ? undefined : (result.error ?? 'cancel_failed'),
    };
  });
}
/**
 * Protect past-due schedules that carry durable fire-retry evidence.
 * fireRetryCount is Auto-owned retry evidence surfaced by the native schedule
 * listing; it is not part of Shared ExactAlarm schedule metadata. Stale React
 * global/med disabled state must not drop recovery evidence for an already-failed
 * FIRED persistence.
 */
export function isFireRetryRecoveryPending(
  schedule: ScheduledOccurrence,
  med: Medication | undefined,
  globalAutoDeductEnabled: boolean,
  now: number = Date.now()
): boolean {
  // Durable native retry marker is required. React enable flags are NOT used
  // to erase recovery — only to decide future desired-state scheduling.
  if (Number(schedule.fireRetryCount) <= 0) {
    return false;
  }
  void globalAutoDeductEnabled;
  // Prefer native scheduledAtEpochMs; fall back to timeHhmm or med schedule.
  let scheduledAt: number | null = null;
  if (
    Number.isFinite(Number(schedule.scheduledAtEpochMs)) &&
    Number(schedule.scheduledAtEpochMs) > 0
  ) {
    scheduledAt = Number(schedule.scheduledAtEpochMs);
  } else if (schedule.timeHhmm) {
    scheduledAt = localEpochMs(schedule.calendarDate, schedule.timeHhmm);
  } else if (med) {
    const configuredSlot = getAutoDeductionSlotsForDate(
      med,
      schedule.calendarDate
    ).find((slot) => slot.doseId === schedule.doseId);
    if (configuredSlot) {
      scheduledAt = localEpochMs(schedule.calendarDate, configuredSlot.time);
    }
  }
  // Without a due timestamp we still protect the row when fireRetryCount > 0:
  // stale React med/global state must not cancel durable failed-fire evidence.
  if (scheduledAt == null) {
    return true;
  }
  return scheduledAt <= now + 2_000;
}
export function useAutoDeductionScheduler({
  medications,
  globalAutoDeductEnabled,
  hydrated,
  isFirstRun,
  exactAlarmPermission,
  resumeTick = 0,
  midnightTick = 0,
}: UseAutoDeductionSchedulerOptions): void {
  const trackedRef = useRef<Set<string>>(new Set());
  const generationGuardRef = useRef(new GenerationGuard<string>());
  const operationQueueRef = useRef(new OperationQueue<string>());
  const recoveryBoundaryRef = useRef<string | null>(null);
  const signature = useMemo(
    () =>
      [
        globalAutoDeductEnabled ? '1' : '0',
        exactAlarmPermission === 'granted' ? '1' : exactAlarmPermission === 'denied' ? '0' : 'u',
        medications
          .map((m) => {
            const schedulePart =
              Array.isArray(m.doseSchedule) && m.doseSchedule.length > 0
                ? m.doseSchedule
                    .map((d) => `${d.id}@${d.time}@${d.amount}`)
                    .join(',')
                : '';
            // Exact Auto desired slots come only from explicit doseSchedule.
            // reminderEnabled/reminderTime/dailyDose do not define Exact occurrences.
            return [
              m.id,
              m.autoDeductEnabled === false ? '0' : '1',
              m.isChronic === false ? 'temporary' : 'chronic',
              getMedicationTreatmentEndDate(m) ?? '',
              m.treatmentStartDate ?? '',
              schedulePart,
            ].join('|');
          })
          .sort()
          .join('\n'),
      ].join('#'),
    [medications, globalAutoDeductEnabled, exactAlarmPermission]
  );
  useEffect(() => {
    if (!hydrated || isFirstRun) return;
    if (exactAlarmPermission === null || exactAlarmPermission === 'denied') {
      if (exactAlarmPermission === 'denied') {
        const gen = generationGuardRef.current.bump('auto-deduction');
        const toCancel = Array.from(trackedRef.current);
        operationQueueRef.current.enqueue('auto-deduction', async () => {
          if (!generationGuardRef.current.isCurrent('auto-deduction', gen)) return;
          for (const key of toCancel) {
            const [medId, doseId, date] = key.split('::');
            if (medId && doseId && date) {
              const res = await cancelUndesiredExactOccurrence(
                medId,
                doseId,
                date,
                /* force */ true
              );
              // Only drop tracking when native reports terminal success.
              if (res.ok && generationGuardRef.current.isCurrent('auto-deduction', gen)) {
                trackedRef.current.delete(key);
              }
            }
          }
        });
      }
      return;
    }
    const gen = generationGuardRef.current.bump('auto-deduction');
    const today = getTodayDateString();
    const tomorrow = tomorrowDateString(today);
    const now = Date.now();
    const desired = new Map<string, AutoDeductionSlot>();
    // Per-medication Auto only (getAutoDeductionSlotsForDate returns [] when OFF).
    for (const med of medications) {
      for (const date of [today, tomorrow]) {
        for (const slot of getAutoDeductionSlotsForDate(med, date)) {
          const epoch = localEpochMs(slot.calendarDate, slot.time);
          if (epoch == null) continue;
          if (epoch <= now - 2000) continue;
          const key = autoDeductionScheduleKey(slot.medId, slot.doseId, slot.calendarDate);
          desired.set(key, slot);
        }
      }
    }
    operationQueueRef.current.enqueue('auto-deduction', async () => {
      if (!generationGuardRef.current.isCurrent('auto-deduction', gen)) return;
      // Recovery boundary: rebuild/promo any past native schedule entries before
      // the destructive desired-state comparison. This makes missed fires
      // recoverable after app restart/resume/midnight without foreground polling.
      const recoveryBoundary = recoveryBoundaryKey(resumeTick, midnightTick);
      if (recoveryBoundaryRef.current !== recoveryBoundary) {
        const restoreResult = await restoreFutureSchedulesOnce(recoveryBoundary);
        if (!restoreResult.ok) {
          // Fail-closed: incomplete recovery must not drive destructive cleanup.
          // Leave recoveryBoundaryRef unchanged so a later pass retries restore.
          console.warn(
            '[App] AutoDeduction restoreFutureSchedules failed — skipping desired-state cleanup:',
            restoreResult.error || 'restore_failed'
          );
          return;
        }
        recoveryBoundaryRef.current = recoveryBoundary;
        if (!generationGuardRef.current.isCurrent('auto-deduction', gen)) return;
      }
      // Reconcile against durable native schedule metadata (not process-local
      // trackedRef alone). After restart trackedRef is empty; native may still
      // hold stale schedules for disabled/deleted meds — cancel those first.
      // System boot / permission re-grant restore is handled by
      // Shared system lifecycle recovery is handled natively; this normal desired-state pass
      // remains limited to reconciling the current desired schedule state.
      // The native list is authoritative for durable-schedule discovery.
      // Distinguish success+empty from read failure — never treat failure as [].
      const listResult = await listScheduledAutoDeductionOccurrences();
      if (listResult.ok) {
        // Authoritative native snapshot available — discover + reconcile.
        const listedKeys = new Set<string>();
        const retryProtectedKeys = new Set<string>();
        for (const s of listResult.schedules) {
          if (!generationGuardRef.current.isCurrent('auto-deduction', gen)) return;
          const key = autoDeductionScheduleKey(
            s.medicationId,
            s.doseId,
            s.calendarDate
          );
          listedKeys.add(key);
          if (!desired.has(key)) {
            const durableMed = medications.find((m) => m.id === s.medicationId);
            if (isFireRetryRecoveryPending(
              s,
              durableMed,
              globalAutoDeductEnabled
            )) {
              // This past-due schedule is the durable recovery source for a
              // failed fire-persistence retry. Do not invalidate/cancel it
              // merely because it falls outside today's/tomorrow's desired set.
              retryProtectedKeys.add(key);
              trackedRef.current.delete(key);
              continue;
            }
            // The durable generation bump MUST succeed before any
            // occurrence cancel. Cancel-without-invalidate leaves the old
            // generation active so a concurrent receiver can still create D+1.
            const res = await cancelUndesiredExactOccurrence(
              s.medicationId,
              s.doseId,
              s.calendarDate
            );
            if (!res.ok) {
              // Fail-closed: keep tracking, skip cancel, retry next pass.
              continue;
            }
            if (!res.skipped && generationGuardRef.current.isCurrent('auto-deduction', gen)) {
              trackedRef.current.delete(key);
            }
          } else {
            // Still desired — track so later passes can cancel if removed.
            trackedRef.current.add(key);
          }
        }
        if (!generationGuardRef.current.isCurrent('auto-deduction', gen)) return;
        // The successful native list is authoritative. A tracked key that
        // disappeared from the native snapshot is already absent natively;
        // delete only the process-local tracking entry. Do NOT invalidate the
        // recurrence chain just because an earlier snapshot was resolved by
        // native recovery between passes (e.g. midnight/resume catch-up).
        for (const key of Array.from(trackedRef.current)) {
          if (!listedKeys.has(key) && !retryProtectedKeys.has(key)) {
            trackedRef.current.delete(key);
          }
        }
      } else {
        // Fail closed: a native list failure is never treated as an empty set.
        // No invalidate/cancel from native absence or trackedRef in this pass.
        // trackedRef is left unchanged for a later successful reconciliation.
      }
      if (!generationGuardRef.current.isCurrent('auto-deduction', gen)) return;
      for (const [key, slot] of desired) {
        if (!generationGuardRef.current.isCurrent('auto-deduction', gen)) return;
        const result = await scheduleExactOccurrenceFromDurable(slot);
        if (
          result.ok &&
          !(result as { skipped?: boolean }).skipped &&
          generationGuardRef.current.isCurrent('auto-deduction', gen)
        ) {
          trackedRef.current.add(key);
        } else if (!result.ok && result.error === 'exact_alarm_permission_denied') {
          break;
        }
      }
    });
  }, [
    signature,
    hydrated,
    isFirstRun,
    exactAlarmPermission,
    globalAutoDeductEnabled,
    medications,
    resumeTick,
    midnightTick,
  ]);
}