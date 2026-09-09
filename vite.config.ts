import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // Use a relative base so the production build works inside an
    // Android WebView (Capacitor) and any sub-path deployment, not
    // just the site root. AI Studio's preview serves from `/` so
    // relative paths resolve correctly there too.
    base: './',
    plugins: [react(), tailwindcss()],
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
      // Target ES2020 for broad browser support. The build produces
      // multiple chunks (entry + dynamic imports) with content-hashed
      // names; the service worker parses /index.html on install to
      // pre-cache them (see public/sw.js #23).
      target: 'es2020',
    },
  };
});
