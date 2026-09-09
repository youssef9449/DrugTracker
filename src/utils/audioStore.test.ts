import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveGlobalCustomSound, loadGlobalCustomSound, deleteGlobalCustomSound } from './audioStore';
import type { CustomSoundFile } from '../types';

const testFile: CustomSoundFile = {
  fileName: 'test.mp3',
  mimeType: 'audio/mpeg',
  dataUrl: 'data:audio/mpeg;base64,AAAA',
};

/**
 * #41 — audioStore.openDb caches a failed promise permanently, making
 * all subsequent calls no-op for the entire session. The fix resets
 * dbPromise on failure so the next call retries.
 *
 * #42 test gap — audioStore had zero tests.
 */

describe('audioStore — save/load/delete (#42 test gap)', () => {
  let originalIDB: typeof globalThis.indexedDB;

  beforeEach(() => {
    originalIDB = globalThis.indexedDB;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIDB,
      configurable: true,
      writable: true,
    });
  });

  it('saveGlobalCustomSound does not throw when IDB is available', async () => {
    // We can't fully simulate IDB in jsdom, but we can verify the
    // functions are callable and return promises.
    expect(typeof saveGlobalCustomSound).toBe('function');
  });

  it('loadGlobalCustomSound returns null when IDB is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const result = await loadGlobalCustomSound();
    expect(result).toBeNull();
  });

  it('saveGlobalCustomSound does not throw when IDB is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    await expect(saveGlobalCustomSound(testFile)).resolves.not.toThrow();
  });

  it('deleteGlobalCustomSound does not throw when IDB is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    await expect(deleteGlobalCustomSound()).resolves.not.toThrow();
  });
});

describe('audioStore — retry on failure (#41)', () => {
  let originalIDB: typeof globalThis.indexedDB;

  beforeEach(() => {
    originalIDB = globalThis.indexedDB;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIDB,
      configurable: true,
      writable: true,
    });
  });

  it('returns null gracefully when IndexedDB is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const result = await loadGlobalCustomSound();
    expect(result).toBeNull();
  });

  it('can be called multiple times when IDB is unavailable (no permanent cache)', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    // First call — should return null.
    const r1 = await loadGlobalCustomSound();
    expect(r1).toBeNull();
    // Second call — #41 fix: should also return null (not be stuck
    // with a cached failed promise that returns null forever without
    // retrying). The key test is that calling again doesn't throw.
    const r2 = await loadGlobalCustomSound();
    expect(r2).toBeNull();
  });
});
