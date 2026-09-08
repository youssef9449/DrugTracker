/**
 * with-app-env.mjs — pass-through shim for the Drug Tracker app.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This file is not actually needed by the current Vite + React build.
 * The real `dev` script in package.json is simply:
 *
 *     vite --port=3000 --host=0.0.0.0
 *
 * This file only exists for backwards compatibility with cached
 * development environments (e.g., Google AI Studio's preview server)
 * that may still be running an older cached `package.json` from the
 * deleted TanStack Start rewrite (commit ac287a5). The cached dev
 * script was:
 *
 *     node scripts/with-app-env.mjs vite dev --host 0.0.0.0 --port 8080
 *
 * which called this file to load `.env` files before forwarding to
 * vite. The TanStack Start project had real env-loading logic here.
 *
 * After we reverted to plain Vite + React, this file no longer
 * exists in the repo, so the cached dev script in AI Studio's preview
 * fails with `Cannot find module '/app/applet/scripts/with-app-env.mjs'`.
 *
 * Keeping this minimal pass-through shim ensures the cached script
 * can still find and run the file, which then simply forwards all
 * arguments to the `vite` binary. Vite itself handles `.env` loading
 * natively (see https://vitejs.dev/guide/env-and-mode.html), so no
 * special env preprocessing is required.
 *
 * USAGE
 * -----
 *     node scripts/with-app-env.mjs <vite args...>
 *
 * Forwards to: `npx vite <vite args...>`
 *
 * If the user updates their AI Studio to the latest package.json,
 * the `dev` script becomes `vite --port=3000 --host=0.0.0.0` and this
 * file is no longer invoked at all. It can be safely deleted once
 * the AI Studio cache is cleared.
 */

import { spawn } from 'node:child_process';

// Strip the leading node binary + script path from argv.
// Remaining items are forwarded to vite.
const [, , ...viteArgs] = process.argv;

const child = spawn('npx', ['vite', ...viteArgs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[with-app-env.mjs] Failed to spawn vite:', err.message);
  process.exit(1);
});
