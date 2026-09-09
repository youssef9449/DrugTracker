import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateSchema } from './migration';

/**
 * #42 test gap — migrateSchema runs on every mount but had zero tests.
 * Tests: first call returns true + sets marker, second call returns false,
 * localStorage unavailable returns false, downgrade detection warns.
 */
describe('migrateSchema (#42 test gap)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('returns true on first call and sets the schema-applied marker', () => {
    const result = migrateSchema();
    expect(result).toBe(true);
    // The marker key should be set.
    expect(localStorage.getItem('android_med_tracker_schema_applied_v2')).toBe('1');
  });

  it('returns false on second call (already applied)', () => {
    migrateSchema(); // first call
    const result = migrateSchema(); // second call
    expect(result).toBe(false);
  });

  it('is idempotent — calling 5 times only sets the marker once', () => {
    migrateSchema();
    migrateSchema();
    migrateSchema();
    migrateSchema();
    migrateSchema();
    expect(localStorage.getItem('android_med_tracker_schema_applied_v2')).toBe('1');
  });

  it('warns when a newer schema marker exists (downgrade detection)', () => {
    // Simulate a newer schema (v3) having been applied by a newer build.
    localStorage.setItem('android_med_tracker_schema_applied_v3', '1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    migrateSchema();
    // The warn should mention the newer schema.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Detected newer schema v3')
    );
    warnSpy.mockRestore();
  });

  it('does NOT delete newer data on downgrade', () => {
    localStorage.setItem('android_med_tracker_schema_applied_v3', '1');
    migrateSchema();
    // The v3 marker must still be there (downgrade doesn't delete).
    expect(localStorage.getItem('android_med_tracker_schema_applied_v3')).toBe('1');
  });

  it('returns false when localStorage is unavailable', () => {
    // Simulate localStorage being unavailable by wrapping getItem to throw.
    const original = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: () => { throw new Error('unavailable'); },
          setItem: () => { throw new Error('unavailable'); },
          removeItem: () => { throw new Error('unavailable'); },
          clear: () => {},
          key: () => null,
          length: 0,
        },
        configurable: true,
        writable: true,
      });
      const result = migrateSchema();
      expect(result).toBe(false);
    } finally {
      // Restore.
      Object.defineProperty(globalThis, 'localStorage', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});
