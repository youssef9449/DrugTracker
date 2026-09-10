import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadJson, loadString, saveJson, saveString, persist } from './storage';

beforeEach(() => {
  localStorage.clear();
});

describe('loadJson', () => {
  it('returns the parsed value when the key exists', () => {
    localStorage.setItem('k', JSON.stringify({ a: 1 }));
    expect(loadJson('k', null)).toEqual({ a: 1 });
  });

  it('returns the fallback when the key is absent', () => {
    expect(loadJson('missing', { a: 1 })).toEqual({ a: 1 });
    expect(loadJson('missing', null)).toBeNull();
    expect(loadJson('missing', [])).toEqual([]);
  });

  it('returns the fallback when parsing fails', () => {
    localStorage.setItem('k', 'not-json{');
    expect(loadJson('k', 'fallback')).toBe('fallback');
  });

  it('preserves array types', () => {
    localStorage.setItem('arr', JSON.stringify([1, 2, 3]));
    expect(loadJson<number[]>('arr', [])).toEqual([1, 2, 3]);
  });

  it('stores null as a valid JSON value (distinguishes null from absent)', () => {
    localStorage.setItem('k', 'null');
    expect(loadJson('k', 'fallback')).toBeNull();
  });
});

describe('loadString', () => {
  it('returns the raw string when the key exists', () => {
    localStorage.setItem('k', 'raw-value');
    expect(loadString('k', '')).toBe('raw-value');
  });

  it('returns the fallback when the key is absent', () => {
    expect(loadString('missing', 'default')).toBe('default');
  });

  it('returns the fallback when reading throws', () => {
    // Simulate a throw by spying on getItem.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(loadString('k', 'safe')).toBe('safe');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('saveJson', () => {
  it('writes the JSON-stringified value', () => {
    saveJson('k', { a: 1 });
    expect(localStorage.getItem('k')).toBe('{"a":1}');
  });

  it('handles arrays', () => {
    saveJson('k', [1, 2, 3]);
    expect(localStorage.getItem('k')).toBe('[1,2,3]');
  });

  it('swallows quota errors silently (does not throw)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      expect(() => saveJson('k', { a: 1 })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('saveString', () => {
  it('writes the raw string without JSON.stringify', () => {
    saveString('k', 'true');
    expect(localStorage.getItem('k')).toBe('true');
    saveString('k', 'large');
    expect(localStorage.getItem('k')).toBe('large');
  });

  it('swallows errors silently', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(() => saveString('k', 'v')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('persist (error-surfacing writer)', () => {
  it('returns null on success and writes JSON by default', () => {
    const result = persist('k', { a: 1 });
    expect(result).toBeNull();
    expect(localStorage.getItem('k')).toBe('{"a":1}');
  });

  it('writes a raw string when json:false', () => {
    const result = persist('k', 'true', { json: false });
    expect(result).toBeNull();
    expect(localStorage.getItem('k')).toBe('true');
  });

  it('returns the quota error message on QuotaExceededError', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      const result = persist('k', { a: 1 });
      expect(result).toBe('مساحة التخزين ممتلئة');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns the generic error message on other failures', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const result = persist('k', { a: 1 });
      expect(result).toBe('تعذّر حفظ البيانات');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns null when localStorage is undefined (SSR guard)', () => {
    // The persist() helper has a `typeof localStorage === 'undefined'` SSR
    // guard. In jsdom localStorage always exists, so we spy on the global
    // reference to simulate its absence and verify the guard returns null
    // (without attempting any write).
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      // Remove the global localStorage property entirely so `typeof localStorage`
      // becomes 'undefined'.
      // @ts-expect-error — intentionally delete to simulate SSR
      delete globalThis.localStorage;
      // Re-define as undefined so the reference resolves but typeof is 'undefined'.
      Object.defineProperty(globalThis, 'localStorage', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(persist('k', 'v', { json: false })).toBeNull();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
      }
    }
  });
});
