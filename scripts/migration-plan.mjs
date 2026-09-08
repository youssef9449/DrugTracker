/**
 * migration-plan.mjs — no-op stub.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Same situation as the other two stubs in this folder: AI Studio
 * may run a cached `vite.config.ts` from the deleted TanStack Start
 * rewrite (commit ac287a5) that imports:
 *
 *     import { isMigrationFile } from './scripts/migration-plan.mjs'
 *
 * After the rewrite was reverted, this file no longer exists in the
 * repo, but the cached import fails. This no-op stub keeps the
 * cached import resolvable. It can be deleted once AI Studio
 * re-fetches the latest vite.config.ts.
 *
 * The original `isMigrationFile` was a helper used by the TanStack
 * Start build to identify SQL migration files so they could be
 * excluded from the client bundle. A plain Vite SPA does not have
 * SQL migrations, so this stub always returns `false`.
 */

/**
 * Returns false for every path — there are no migration files in
 * a plain Vite + React SPA. This shape matches what the cached
 * vite.config.ts expects (a function that takes a file id/path
 * and returns a boolean).
 *
 * @param {string} _id
 * @returns {boolean}
 */
export function isMigrationFile(_id) {
  return false;
}
