/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type PluginOption } from 'vite';

/**
 * Generate the production Service Worker from the repository template.
 * The Rollup output hook injects a content-derived cache identity and the
 * complete emitted JS/CSS asset list, so the SW never reads or writes dist/
 * directly and dynamic-import chunks are included in the offline cache.
 */
function swCacheVersionPlugin(): PluginOption {
  const swTemplatePath = path.resolve(__dirname, 'public', 'sw.js');
  const cacheVersionToken = '__CACHE_VERSION__';
  const precacheToken = '/* __PRECACHE_ASSETS__ */ []';
  let swTemplate = '';

  function replaceRequiredToken(
    source: string,
    token: string,
    replacement: string,
    label: string
  ): string {
    const count = source.split(token).length - 1;
    if (count !== 1) {
      throw new Error(
        `Service Worker template must contain exactly one ${label} placeholder; found ${count}`
      );
    }
    return source.replace(token, replacement);
  }

  return {
    name: 'sw-cache-version',
    apply: 'build',
    buildStart() {
      swTemplate = readFileSync(swTemplatePath, 'utf-8');
      this.addWatchFile(swTemplatePath);
    },
    generateBundle(_, bundle) {
      const productionAssets = Object.values(bundle)
        .filter((item) => {
          const fileName = item.fileName.toLowerCase();
          return fileName.endsWith('.js') || fileName.endsWith('.css');
        })
        .map((item) => item.fileName)
        .sort();

      const cacheVersion = createHash('sha256')
        .update(swTemplate)
        .update('\n')
        .update(productionAssets.join('\n'))
        .digest('hex')
        .slice(0, 12);

      let source = replaceRequiredToken(
        swTemplate,
        cacheVersionToken,
        cacheVersion,
        'cache-version'
      );
      source = replaceRequiredToken(
        source,
        precacheToken,
        JSON.stringify(productionAssets),
        'precache-assets'
      );

      if (
        source.includes(cacheVersionToken) ||
        source.includes('__PRECACHE_ASSETS__')
      ) {
        throw new Error(
          'Service Worker template placeholders were not completely resolved'
        );
      }

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source,
      });
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
      // names; the Vite SW plugin injects every emitted JS/CSS file into
      // the Service Worker's precache list.
      target: 'es2022',
    },
    test: {
      // jsdom so component tests (React Testing Library) and any util
      // that touches `window`/`localStorage`/`FileReader` work. The
      // pure-utils tests run fine under jsdom too — they don't rely on
      // node-only APIs.
      environment: 'jsdom',
      include: ['Tests/**/*.test.ts', 'Tests/**/*.test.tsx'],
      globals: false,
      setupFiles: ['./vitest.setup.ts'],
    },
  };
});
