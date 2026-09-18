/**
 * Sentinel doseId for legacy (non-scheduled) single-dose medications.
 *
 * Lives in its own leaf module (no imports) so pure-logic modules such as
 * `dateCalculations.ts` can reference the sentinel without pulling the
 * notification stack (Capacitor plugin registration) into their module
 * graph. `notifications.ts` re-exports this constant for backward
 * compatibility with its existing importers.
 *
 * Occurrence identity for a legacy med's implicit daily dose is
 * medicationId + LEGACY_DOSE_ID + calendarDate — the same
 * per-occurrence contract as scheduled multi-dose slots.
 */
export const LEGACY_DOSE_ID = 'legacy';
