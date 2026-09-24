/**
 * Deterministic persisted-medication localStorage readers for tests.
 * Callers supply explicit fixtures; no global mutable test state.
 */
import { STORAGE_MEDS_KEY } from '../../src/constants/storageKeys';
import type { Medication } from '../../src/types';

export function readPersistedMedications(): Medication[] {
  try {
    const raw = localStorage.getItem(STORAGE_MEDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Medication[]) : [];
  } catch {
    return [];
  }
}

export function writePersistedMedications(meds: Medication[]): void {
  localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify(meds));
}

export function clearPersistedMedications(): void {
  localStorage.removeItem(STORAGE_MEDS_KEY);
}
