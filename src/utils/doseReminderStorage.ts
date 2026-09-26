/** Persistent per-dose snooze marker with failure-aware accessors. */
import { loadValidatedJson, readJsonOutcome, saveJson, type JsonParserVerdict } from './storage';

export const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

/** Runtime validator for the persisted snooze map (doseKey → epoch ms). */
function parseSnoozeMap(raw: unknown): JsonParserVerdict<Record<string, number>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'snooze_map_shape_invalid' };
  }
  const map: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: 'snooze_map_value_invalid' };
    }
    map[key] = value;
  }
  return { ok: true, value: map };
}

export function snoozeStorageKey(medId: string, doseId: string): string | null {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return null;
  return `${medId}::${id}`;
}

export type SnoozeUntilReadOutcome =
  | { status: 'ok'; value: number | null }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }
  | { status: 'read_failed'; reason: string };

export function getSnoozeUntil(
  medId: string,
  doseId: string
): SnoozeUntilReadOutcome {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return { status: 'invalid', reason: 'snooze_key_invalid' };

  const outcome = readJsonOutcome(SNOOZE_KEY, parseSnoozeMap);
  if (outcome.status !== 'ok') return outcome;

  const until = outcome.value[key];
  return {
    status: 'ok',
    value: typeof until === 'number' && Number.isFinite(until) ? until : null,
  };
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
  const outcome = getSnoozeUntil(medId, doseId);
  if (outcome.status === 'invalid' || outcome.status === 'read_failed') {
    // Fail closed: corrupted/unreadable durable snooze state must not make a
    // reminder eligible until the persisted state can be reconciled.
    return true;
  }
  if (outcome.status !== 'ok') return false;
  return outcome.value != null && nowMs < outcome.value;
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
