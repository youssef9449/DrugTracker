/**
 * Lightweight localStorage schema versioning + migration.
 *
 * The app's persisted state lives under versioned keys
 * (`android_med_tracker_items_v2`, `…_logs_v2`, `…_pharmacy_v2`, …).
 * The previous approach had two problems:
 *   1. There was no single "schema version" — each key carried its own
 *      `_vN` suffix, and bumping one without the other could leave the
 *      app reading a mix of old + new shapes.
 *   2. There was no migration: a user who had `_v1` data silently got
 *      it ignored on upgrade, losing their data with no feedback.
 *
 * This module introduces a single `SCHEMA_VERSION` and a `migrate()`
 * function that runs once per browser (gated by a `schema_applied_v{N}`
 * flag in localStorage). Today the migration is a no-op pass-through
 * (the app shipped at v2 keys and there is no real v1 user base to
 * migrate), but the structure is here so the NEXT schema bump can
 * add a real migration step without touching App.tsx.
 *
 * The migration is also defensive: if the stored schema is NEWER than
 * the running code expects (downgrade scenario — user installed an
 * older build over a newer one), we log a warning so the user can
 * understand why their data looks odd. We deliberately do NOT delete
 * the newer data; a re-upgrade will pick it back up.
 */

/** Current schema version this build understands. */
export const SCHEMA_VERSION = 2;

/** localStorage key recording the last schema version we applied. */
const SCHEMA_APPLIED_KEY = `android_med_tracker_schema_applied_v${SCHEMA_VERSION}`;

/**
 * Run schema migration. Call once during app hydration (before reading
 * any persisted state). Idempotent — safe to call multiple times.
 *
 * @returns true if this was the first migration run for this version,
 *   false if it had already been applied (or localStorage is unavailable).
 */
export function migrateSchema(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const alreadyApplied = localStorage.getItem(SCHEMA_APPLIED_KEY);
    if (alreadyApplied === '1') return false;

    // Future migrations would go here, e.g.:
    //   const oldMeds = localStorage.getItem('android_med_tracker_items_v1');
    //   if (oldMeds && !localStorage.getItem(STORAGE_MEDS_KEY)) {
    //     localStorage.setItem(STORAGE_MEDS_KEY, migrateV1Meds(oldMeds));
    //     localStorage.removeItem('android_med_tracker_items_v1');
    //   }

    // Defensive downgrade check: if a *newer* schema marker exists, the
    // user is running an older build over newer data. Don't delete it;
    // just warn so the downgrade is diagnosable.
    for (let v = SCHEMA_VERSION + 1; v <= SCHEMA_VERSION + 5; v++) {
      const newerMarker = localStorage.getItem(
        `android_med_tracker_schema_applied_v${v}`
      );
      if (newerMarker === '1') {
        console.warn(
          `[migration] Detected newer schema v${v} data while running v${SCHEMA_VERSION}. ` +
            'Some features may appear missing until you upgrade the app.'
        );
        break;
      }
    }

    localStorage.setItem(SCHEMA_APPLIED_KEY, '1');
    return true;
  } catch (err) {
    console.warn('[migration] schema migration failed:', err);
    return false;
  }
}
