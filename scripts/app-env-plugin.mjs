/**
 * app-env-plugin.mjs — no-op stub.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Same situation as `grok-pwa-plugin.mjs`: AI Studio may run a
 * cached `vite.config.ts` from the deleted TanStack Start rewrite
 * (commit ac287a5) that imports:
 *
 *     import { appEnvPlugin } from './scripts/app-env-plugin.mjs'
 *
 * After the rewrite was reverted, this file no longer exists in
 * the repo, but the cached import fails. This no-op stub keeps
 * the cached import resolvable so the dev server boots. It can
 * be deleted once AI Studio re-fetches the latest vite.config.ts.
 *
 * The original plugin injected environment variables (read from
 * `.env` files) into the runtime. Vite itself handles `.env`
 * loading natively via `import.meta.env` (see
 * https://vitejs.dev/guide/env-and-mode.html), so a no-op stub
 * is sufficient for a plain Vite SPA.
 */

/**
 * Returns a no-op Vite plugin.
 *
 * @returns {import('vite').Plugin}
 */
export function appEnvPlugin() {
  return {
    name: 'app-env-plugin-stub',
    enforce: 'pre',
    // Intentionally empty.
  };
}
