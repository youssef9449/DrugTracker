/** Persistent per-dose snooze marker with failure-aware accessors. */
import { loadValidatedJson, saveJson } from './storage';

export const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

/** Runtime validator for the persisted snooze map (doseKey → epoch ms). */
function parseSnoozeMap(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const map: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    map[key] = value;
  }
  return map;
}

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
  const snooze = loadValidatedJson(SNOOZE_KEY, parseSnoozeMap, {});
  const until = snooze[key];
  return typeof until === 'number' && Number.isFinite(until)
    ? until
    : null;
}

export function clearSnoozedDose(medId: string, doseId: string): boolean {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return false;
  const snooze = loadValidatedJson(SNOOZE_KEY, parseSnoozeMap, {});
  if (snooze[key] !== undefined) {
    delete snooze[key];
    return saveJson(SNOOZE_KEY, snooze) === null;
  }
  return true;
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
): boolean {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return false;
  const snooze = loadValidatedJson(SNOOZE_KEY, parseSnoozeMap, {});
  snooze[key] = untilMs;
  return saveJson(SNOOZE_KEY, snooze) === null;
}
