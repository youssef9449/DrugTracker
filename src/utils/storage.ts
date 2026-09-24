/**
 * Shared localStorage helpers.
 *
 * Previously:
 * - `loadJson`/`saveJson` were previously private to useDoseReminders.ts;
 *   the writer silently swallowed failures.
 * - App.tsx had 3 inlined `try { JSON.parse(localStorage.getItem(...)) }`
 *   copies + 4 inlined raw-string reads.
 * - App.tsx also had `persistJson` and `persistString` — near-identical
 *   error-surfacing writers (differed only by JSON.stringify).
 *
 * This module consolidates all of them:
 * - `loadJson` / `loadString`: silent readers (return fallback on error).
 * - `saveJson` / `saveString`: failure-aware writers (return null on success or an error message on failure).
 * - `saveJsonBestEffort` / `saveStringBestEffort`: explicitly silent writers for non-critical preferences only.
 * - `persist`: error-surfacing writer (returns null on success or an
 *   Arabic error message on failure — used by the persistence effects in
 *   App.tsx so they can toast the user on quota exhaustion).
 */
import { STORAGE_ERRORS } from '../constants/uiStrings';
import type { ConsumptionLog, Medication } from '../types';
export type StorageReadResult =
  | { ok: true; value: string | null }
  | { ok: false; value: null };

/** Read raw localStorage safely while preserving the missing-key distinction. */
export function readStorageItem(key: string): StorageReadResult {
  try {
    return { ok: true, value: localStorage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isDoseRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const dose = value as Record<string, unknown>;
  return (
    isNonEmptyString(dose.id) &&
    isFiniteNumber(dose.amount) &&
    dose.amount > 0 &&
    typeof dose.time === 'string' &&
    /^\\d{2}:\\d{2}$/.test(dose.time) &&
    Number(dose.time.slice(0, 2)) < 24 &&
    Number(dose.time.slice(3, 5)) < 60 &&
    isOptionalString(dose.description)
  );
}

function isHistoryMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (dates) => Array.isArray(dates) && dates.every((date) => typeof date === 'string')
  );
}

export function isValidMedicationRecord(value: unknown): value is Medication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const medication = value as Record<string, unknown>;
  if (
    !isNonEmptyString(medication.id) ||
    !isNonEmptyString(medication.name) ||
    !isFiniteNumber(medication.currentPills) ||
    !isFiniteNumber(medication.dailyDose) ||
    medication.dailyDose <= 0 ||
    typeof medication.unit !== 'string' ||
    !isFiniteNumber(medication.warningThresholdDays) ||
    !isNonEmptyString(medication.colorTag) ||
    !isNonEmptyString(medication.createdAt) ||
    !isOptionalString(medication.category) ||
    !isOptionalString(medication.notes) ||
    !isOptionalString(medication.treatmentStartDate) ||
    !isOptionalString(medication.lastConsumedDate)
  ) return false;
  if (
    medication.autoDeductEnabled !== undefined &&
    typeof medication.autoDeductEnabled !== 'boolean'
  ) return false;
  if (medication.isChronic !== undefined && typeof medication.isChronic !== 'boolean') return false;
  for (const key of ['durationDays', 'packageSize', 'stripsPerBox', 'pillsPerStrip', 'targetOrderQuantity', 'dosesPerDay']) {
    const current = medication[key];
    if (current !== undefined && (!isFiniteNumber(current) || current <= 0)) return false;
  }
  if (medication.reminderEnabled !== undefined && typeof medication.reminderEnabled !== 'boolean') return false;
  if (medication.reminderTime !== undefined && (
    typeof medication.reminderTime !== 'string' || !/^\\d{2}:\\d{2}$/.test(medication.reminderTime)
  )) return false;
  if (medication.criticalStockAlertsEnabled !== undefined && typeof medication.criticalStockAlertsEnabled !== 'boolean') return false;
  if (medication.dosesPerDay !== undefined && !Number.isInteger(medication.dosesPerDay)) return false;
  if (medication.doseSchedule !== undefined && (
    !Array.isArray(medication.doseSchedule) || !medication.doseSchedule.every(isDoseRecord)
  )) return false;
  if (!isHistoryMap(medication.doseConsumptionHistory) || !isHistoryMap(medication.doseSkippedHistory)) return false;
  return true;
}

const CONSUMPTION_LOG_TYPES = new Set<ConsumptionLog['type']>([
  'exact_auto', 'refill', 'refill_undo', 'manual_adjust', 'skipped_day', 'dose_taken',
]);

export function isValidConsumptionLogRecord(value: unknown): value is ConsumptionLog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const log = value as Record<string, unknown>;
  return (
    isNonEmptyString(log.id) &&
    isNonEmptyString(log.medicationId) &&
    typeof log.medicationName === 'string' &&
    typeof log.type === 'string' && CONSUMPTION_LOG_TYPES.has(log.type as ConsumptionLog['type']) &&
    isFiniteNumber(log.amount) &&
    typeof log.date === 'string' &&
    /^\\d{4}-\\d{2}-\\d{2}$/.test(log.date) &&
    isNonEmptyString(log.timestamp) &&
    typeof log.description === 'string' &&
    isOptionalString(log.reversedAt) &&
    isOptionalString(log.relatedLogId) &&
    isOptionalString(log.doseId)
  );
}

/**
 * Read and JSON.parse a localStorage value. Returns `fallback` if the key
 * is absent or parsing fails. Never throws.
 */
export function loadJson<T>(key: string, fallback: T): T {
  const result = readStorageItem(key);
  if (!result.ok || result.value == null) return fallback;
  try {
    return JSON.parse(result.value) as T;
  } catch {
    return fallback;
  }
}
/**
 * Read a raw string from localStorage. Returns `fallback` if the key is
 * absent or reading fails. Never throws.
 */
export function loadString(key: string, fallback: string): string {
  const result = readStorageItem(key);
  return !result.ok || result.value == null ? fallback : result.value;
}
/**
 * JSON.stringify + write to localStorage. Silently swallows errors (use
 * `persist` if you need to surface quota failures to the user).
 */
export function saveJson(key: string, value: unknown): string | null {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return null;
  } catch (err) {
    return err instanceof DOMException && err.name === 'QuotaExceededError'
      ? STORAGE_ERRORS.quotaExceeded
      : STORAGE_ERRORS.generic;
  }
}
export function saveJsonBestEffort(key: string, value: unknown): void {
  void saveJson(key, value);
}
/**
 * Write a raw string to localStorage. Silently swallows errors.
 */
export function saveString(key: string, value: string): string | null {
  try {
    localStorage.setItem(key, value);
    return null;
  } catch (err) {
    return err instanceof DOMException && err.name === 'QuotaExceededError'
      ? STORAGE_ERRORS.quotaExceeded
      : STORAGE_ERRORS.generic;
  }
}
export function saveStringBestEffort(key: string, value: string): void {
  void saveString(key, value);
}
/**
 * Persist a value to localStorage, returning a descriptive Arabic error
 * message on failure (or null on success). When `json` is true (default),
 * the value is JSON.stringified; otherwise it's written as a raw string.
 *
 * Used by the App.tsx persistence effects so they can toast the user on
 * quota exhaustion instead of silently dropping data.
 *
 * Replaces the previous `persistJson` + `persistString` pair.
 */
export function persist(
  key: string,
  value: unknown,
  opts: { json?: boolean } = {}
): string | null {
  const { json = true } = opts;
  if (typeof localStorage === 'undefined') return null;
  try {
    const payload = json ? JSON.stringify(value) : String(value);
    localStorage.setItem(key, payload);
    return null;
  } catch (err) {
    const reason =
      err instanceof DOMException && err.name === 'QuotaExceededError'
        ? STORAGE_ERRORS.quotaExceeded
        : STORAGE_ERRORS.generic;
    console.warn(`[storage] localStorage.setItem(${key}) failed:`, err);
    return reason;
  }
}