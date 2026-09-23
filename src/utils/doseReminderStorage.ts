/** Persistent per-dose snooze marker with failure-aware accessors. */
import { loadJson, saveJson } from './storage';

export const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

export function snoozeStorageKey(medId: string, doseId: string): string | null {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return null;
  return `${medId}::${id}`;
}

export function getSnoozeUntil(
  medId: string,
  doseId: string
): number | null {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return null;
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  const until = snooze[key];
  return typeof until === 'number' && Number.isFinite(until)
    ? until
    : null;
}

export function clearSnoozedDose(medId: string, doseId: string): void {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return;
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  if (snooze[key] !== undefined) {
    delete snooze[key];
    saveJson(SNOOZE_KEY, snooze);
  }
}

export function isSnoozeActive(
  medId: string,
  doseId: string,
  nowMs: number = Date.now()
): boolean {
  const until = getSnoozeUntil(medId, doseId);
  return until != null && nowMs < until;
}

export function setSnoozeUntil(
  medId: string,
  untilMs: number,
  doseId: string
): void {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return;
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  snooze[key] = untilMs;
  saveJson(SNOOZE_KEY, snooze);
}
