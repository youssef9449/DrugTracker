/**
 * Phase 2 — JS-side scheduler for native exact-time auto-deduction.
 * Independent of notifications. Does NOT mutate currentPills / logs.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { isValidDoseTime, normalizeTimeString } from '../utils/doseSchedule';
import { LEGACY_DOSE_ID } from '../utils/notifications';
import {
  cancelAutoDeduction,
  invalidateAutoDeductionRecurrence,
  scheduleAutoDeduction,
  listScheduledAutoDeductionOccurrences,
} from '../utils/autoDeductionNative';

export interface UseAutoDeductionSchedulerOptions {
  medications: Medication[];
  globalAutoDeductEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmEnabled: boolean | null;
  resumeTick?: number;
}

export interface AutoDeductionSlot {
  medId: string;
  doseId: string;
  time: string;
  amount: number;
  calendarDate: string;
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

  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
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
      });
    }
    return slots;
  }

  if (med.reminderTime && isValidDoseTime(med.reminderTime) && Number(med.dailyDose) > 0) {
    return [
      {
        medId: med.id,
        doseId: LEGACY_DOSE_ID,
        time: normalizeTimeString(med.reminderTime),
        amount: Number(med.dailyDose),
        calendarDate,
      },
    ];
  }

  return [];
}

export function tomorrowDateString(today: string = getTodayDateString()): string {
  const [y, m, d] = today.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function localEpochMs(calendarDate: string, timeHhmm: string): number | null {
  if (!calendarDate || !timeHhmm) return null;
  const parts = calendarDate.split('-').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const colon = timeHhmm.indexOf(':');
  if (colon < 1) return null;
  const h = parseInt(timeHhmm.slice(0, colon), 10);
  const mi = parseInt(timeHhmm.slice(colon + 1), 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  const [y, m, d] = parts;
  const dt = new Date(y, m - 1, d, h, mi, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function useAutoDeductionScheduler({
  medications,
  globalAutoDeductEnabled,
  hydrated,
  isFirstRun,
  exactAlarmEnabled,
  resumeTick = 0,
}: UseAutoDeductionSchedulerOptions): void {
  const trackedRef = useRef<Set<string>>(new Set());
  const generationRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const signature = useMemo(
    () =>
      [
        globalAutoDeductEnabled ? '1' : '0',
        exactAlarmEnabled === true ? '1' : exactAlarmEnabled === false ? '0' : 'x',
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
              m.autoDeductEnabled === false ? '0' : '1',
              m.reminderTime ?? '',
              m.dailyDose,
              schedulePart,
            ].join('|');
          })
          .sort()
          .join('\n'),
      ].join('#'),
    [medications, globalAutoDeductEnabled, exactAlarmEnabled]
  );

  useEffect(() => {
    if (!hydrated || isFirstRun) return;
    if (exactAlarmEnabled !== true) {
      if (exactAlarmEnabled === false) {
        const gen = ++generationRef.current;
        const toCancel = Array.from(trackedRef.current);
        chainRef.current = chainRef.current.then(async () => {
          if (gen !== generationRef.current) return;
          for (const key of toCancel) {
            const [medId, doseId, date] = key.split('::');
            if (medId && doseId && date) {
              const res = await cancelAutoDeduction(medId, doseId, date);
              // Only drop tracking when native reports terminal success.
              if (res.ok && gen === generationRef.current) {
                trackedRef.current.delete(key);
              }
            }
          }
        });
      }
      return;
    }

    const gen = ++generationRef.current;
    const today = getTodayDateString();
    const tomorrow = tomorrowDateString(today);
    const now = Date.now();

    const desired = new Map<string, AutoDeductionSlot>();

    if (globalAutoDeductEnabled) {
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
    }

    chainRef.current = chainRef.current.then(async () => {
      if (gen !== generationRef.current) return;

      // Reconcile against durable native schedule metadata (not process-local
      // trackedRef alone). After restart trackedRef is empty; native may still
      // hold stale schedules for disabled/deleted meds — cancel those first.
      // System boot / permission re-grant restore is handled by
      // AutoDeductionSystemReceiver, not this normal desired-state pass.
      const invalidatedSlots = new Set<string>();
      try {
        const nativeSchedules = await listScheduledAutoDeductionOccurrences();
        for (const s of nativeSchedules) {
          if (gen !== generationRef.current) return;
          const key = autoDeductionScheduleKey(
            s.medicationId,
            s.doseId,
            s.calendarDate
          );
          if (!desired.has(key)) {
            // Issue #217: invalidate recurrence chain before/with cancel so a
            // concurrent post-fire scheduleNext cannot create D+1.
            const slotId = `${s.medicationId}::${s.doseId}`;
            if (!invalidatedSlots.has(slotId)) {
              invalidatedSlots.add(slotId);
              await invalidateAutoDeductionRecurrence(s.medicationId, s.doseId);
            }
            const res = await cancelAutoDeduction(
              s.medicationId,
              s.doseId,
              s.calendarDate
            );
            if (res.ok) {
              trackedRef.current.delete(key);
            }
          } else {
            // Still desired — track so later passes can cancel if removed.
            trackedRef.current.add(key);
          }
        }
      } catch {
        // Non-fatal: fall through to trackedRef + schedule paths.
      }
      if (gen !== generationRef.current) return;

      for (const key of Array.from(trackedRef.current)) {
        if (!desired.has(key)) {
          const [medId, doseId, date] = key.split('::');
          if (medId && doseId && date) {
            const slotId = `${medId}::${doseId}`;
            if (!invalidatedSlots.has(slotId)) {
              invalidatedSlots.add(slotId);
              await invalidateAutoDeductionRecurrence(medId, doseId);
            }
            const res = await cancelAutoDeduction(medId, doseId, date);
            // Retain tracking on FAILED so a later pass can retry cancellation.
            if (res.ok) {
              trackedRef.current.delete(key);
            }
          } else {
            trackedRef.current.delete(key);
          }
        }
      }

      if (gen !== generationRef.current) return;

      for (const [key, slot] of desired) {
        if (gen !== generationRef.current) return;
        const epoch = localEpochMs(slot.calendarDate, slot.time);
        const result = await scheduleAutoDeduction({
          medicationId: slot.medId,
          doseId: slot.doseId,
          calendarDate: slot.calendarDate,
          timeHhmm: slot.time,
          amount: slot.amount,
          scheduledAtEpochMs: epoch ?? undefined,
        });
        if (result.ok) {
          trackedRef.current.add(key);
        } else if (result.error === 'exact_alarm_permission_denied') {
          break;
        }
      }
    });
  }, [
    signature,
    hydrated,
    isFirstRun,
    exactAlarmEnabled,
    globalAutoDeductEnabled,
    medications,
    resumeTick,
  ]);
}
