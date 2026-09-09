import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest configuration for the Drug Tracker.
 *
 * Reuses the Vite React plugin so JSX/TSX transforms the same way it
 * does in the app. The `@` alias mirrors vite.config.ts so tests can
 * import shared utilities by the same paths the app uses.
 *
 * `environment: 'jsdom'` so component tests (React Testing Library) and
 * any util that touches `window`/`localStorage`/`FileReader` work. The
 * pure-utils tests run fine under jsdom too — they don't rely on
 * node-only APIs.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
