/**
 * Shared localStorage helpers.
 *
 * Previously:
 * - `loadJson`/`saveJson` were private to useDoseReminders.ts (silent
 *   variants — return fallback / void on error).
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
/**
 * Read and JSON.parse a localStorage value. Returns `fallback` if the key
 * is absent or parsing fails. Never throws.
 */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
/**
 * Read a raw string from localStorage. Returns `fallback` if the key is
 * absent or reading fails. Never throws.
 */
export function loadString(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch {
    return fallback;
  }
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