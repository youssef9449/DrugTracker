/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, type PluginOption } from 'vite';

/**
 * #117: Inline Vite plugin that injects a build-time cache version into
 * the service worker. `public/sw.js` is served as-is (not processed by
 * Vite), so `define` / `import.meta.env` don't work for it. This plugin
 * hooks into `generateBundle` and rewrites the hardcoded
 * `CACHE_NAME = 'drug-tracker-v5'` in dist/sw.js with a timestamp-based
 * version so every deploy busts the old SW cache automatically — no
 * developer needs to remember to bump the version string.
 */
function swCacheVersionPlugin(): PluginOption {
  return {
    name: 'sw-cache-version',
    apply: 'build',
    generateBundle() {
      const swPath = path.resolve(__dirname, 'dist', 'sw.js');
      try {
        let swContent = readFileSync(swPath, 'utf-8');
        const buildVersion = `drug-tracker-${Date.now()}`;
        swContent = swContent.replace(
          /const CACHE_NAME = 'drug-tracker-v\d+'/,
          `const CACHE_NAME = '${buildVersion}'`
        );
        writeFileSync(swPath, swContent, 'utf-8');
        console.log(`[sw-cache-version] Injected cache name: ${buildVersion}`);
      } catch {
        console.warn('[sw-cache-version] Could not read/write dist/sw.js — skipping cache version injection');
      }
    },
  };
}

export default defineConfig(() => {
  return {
    // Use a relative base so the production build works inside an
    // Android WebView (Capacitor) and any sub-path deployment, not
    // just the site root. AI Studio's preview serves from `/` so
    // relative paths resolve correctly there too.
    base: './',
    plugins: [react(), tailwindcss(), swCacheVersionPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify — file watching is disabled to prevent
      // flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU
      // during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: {
      // Target ES2022 to match the tsconfig target. The build produces
      // multiple chunks (entry + dynamic imports) with content-hashed
      // names; the service worker parses /index.html on install to
      // pre-cache them (see public/sw.js #23).
      target: 'es2022',
    },
    test: {
      // jsdom so component tests (React Testing Library) and any util
      // that touches `window`/`localStorage`/`FileReader` work. The
      // pure-utils tests run fine under jsdom too — they don't rely on
      // node-only APIs.
      environment: 'jsdom',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      globals: false,
      setupFiles: ['./vitest.setup.ts'],
    },
  };
});
