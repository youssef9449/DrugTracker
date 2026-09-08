/**
 * grok-pwa-plugin.mjs — no-op stub.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * This file is not used by the current Vite + React SPA. It exists
 * only to satisfy AI Studio when its preview environment runs a
 * cached copy of `vite.config.ts` from the deleted TanStack Start
 * rewrite (commit ac287a5). The cached config imported:
 *
 *     import { grokPwaPlugin } from './scripts/grok-pwa-plugin.mjs'
 *
 * and used it inside the `plugins` array. After the rewrite was
 * reverted to plain Vite + React, that import path no longer exists
 * in the actual `vite.config.ts`, but AI Studio's cached config
 * still references it and fails with:
 *
 *     Could not resolve "./scripts/grok-pwa-plugin.mjs"
 *
 * Keeping this no-op stub here ensures the cached import resolves
 * to an empty Vite plugin, so the dev server can boot. Once AI
 * Studio re-fetches the latest `vite.config.ts` (which does not
 * import this file at all), this stub becomes dead code and can
 * be safely deleted.
 */

/**
 * Returns a no-op Vite plugin with the same shape the original
 * grokPwaPlugin() returned, so the cached vite.config.ts can call
 * it inside its `plugins: [...]` array without breaking.
 *
 * @returns {import('vite').Plugin}
 */
export function grokPwaPlugin() {
  return {
    name: 'grok-pwa-plugin-stub',
    enforce: 'post',
    // Intentionally empty — no hooks registered.
  };
}
