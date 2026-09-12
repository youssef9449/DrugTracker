/**
 * Vitest global setup.
 *
 * jsdom doesn't implement everything a browser does. We polyfill the
 * bits the test suite touches:
 * - `URL.createObjectURL` / `URL.revokeObjectURL` (referenced by sound.ts
 *   feature-detection; not actually called, but defined so the check
 *   doesn't throw).
 * - `HTMLMediaElement` play()/load() are no-ops (jsdom doesn't decode
 *   audio) so `playCustomSound` in sound.ts doesn't reject during tests.
 * - `window.alert` is stubbed to a no-op so AppHeader's error path
 *   (which calls `window.alert(message)`) doesn't print to the test
 *   console.
 *
 * Also registers the @testing-library/jest-dom matchers (toBeInTheDocument,
 * toBeVisible, etc.) on vitest's expect.
 *
 * Forces the test process timezone to UTC so the reminderTime-gated
 * auto-deduction timing tests (which compare `now`'s local time-of-day
 * to a `reminderTime` "HH:MM") are deterministic across machines. In
 * production the device's real timezone is used (reminderTime is the
 * user's local dose time); this only affects the test environment.
 * Assigning `process.env.TZ` causes Node to re-evaluate the local
 * timezone for subsequent Date operations.
 */
process.env.TZ = 'UTC';

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

if (typeof URL !== 'undefined' && !URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};
}

if (typeof window !== 'undefined') {
  // jsdom HTMLMediaElement.play returns a rejected promise by default;
  // make it resolve so `playCustomSound` is happy.
  const proto = window.HTMLMediaElement.prototype as unknown as {
    play: () => Promise<void>;
    load: () => void;
  };
  proto.play = vi.fn(() => Promise.resolve());
  proto.load = vi.fn(() => undefined);

  // AppHeader surfaces upload errors via window.alert; stub it so the
  // test output stays clean.
  window.alert = vi.fn(() => {});
}
