import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isValidConsumptionLogRecord,
  isValidMedicationRecord,
  loadValidatedJson,
  loadString,
  readJsonOutcome,
  readStorageItem,
  saveJson,
  saveString,
  persist,
  type StorageJsonOutcome,
} from '@/utils/storage';

beforeEach(() => {
  localStorage.clear();
});

describe('readJsonOutcome / loadValidatedJson (runtime-validated reads)', () => {
  const passthrough = (raw: unknown) => raw as { a: number } | null;

  it('returns the parsed value when the key exists', () => {
    localStorage.setItem('k', JSON.stringify({ a: 1 }));
    expect(readJsonOutcome('k', passthrough)).toEqual({ status: 'ok', value: { a: 1 } });
  });

  it('reports missing when the key is absent', () => {
    expect(readJsonOutcome('missing', passthrough)).toEqual({ status: 'missing' });
    expect(loadValidatedJson('missing', passthrough, { a: 1 })).toEqual({ a: 1 });
  });

  it('reports invalid (not fallback-silently) when parsing fails', () => {
    localStorage.setItem('k', 'not-json{');
    const outcome = readJsonOutcome('k', passthrough);
    expect(outcome.status).toBe('invalid');
    expect(loadValidatedJson('k', passthrough, { a: 0 })).toEqual({ a: 0 });
  });

  it('reports invalid when the runtime validator rejects the shape', () => {
    localStorage.setItem('k', JSON.stringify({ wrong: 'shape' }));
    const outcome = readJsonOutcome<{ a: number }>(
      'k',
      (raw) => (raw && typeof raw === 'object' && (raw as { a?: unknown }).a === 1 ? (raw as { a: number }) : null)
    );
    expect(outcome.status).toBe('invalid');
  });

  it('treats null as a valid JSON value distinct from missing', () => {
    localStorage.setItem('k', 'null');
    const outcome = readJsonOutcome<string | null>('k', (raw) => raw as string | null);
    expect(outcome).toEqual({ status: 'ok', value: null });
  });

  it('reports read_failed when storage itself throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const outcome: StorageJsonOutcome<unknown> = readJsonOutcome('k', passthrough);
      expect(outcome.status).toBe('read_failed');
    } finally {
      spy.mockRestore();
    }
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


describe('safe storage boundary', () => {
  it('reports a storage-read failure without throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(readStorageItem('k')).toEqual({ ok: false, value: null });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('hydration record validation', () => {
  const medication = {
    id: 'med-1',
    name: 'دواء',
    currentPills: 20,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    doseSchedule: [{ id: 'dose-1', amount: 1, time: '09:30' }],
  };

  const log = {
    id: 'log-1',
    medicationId: 'med-1',
    medicationName: 'دواء',
    type: 'dose_taken' as const,
    amount: -1,
    date: '2026-01-01',
    timestamp: '2026-01-01T09:30:00.000Z',
    description: 'dose',
  };

  it('accepts a valid medication and rejects malformed medication entries', () => {
    expect(isValidMedicationRecord(medication)).toBe(true);
    expect(isValidMedicationRecord(null)).toBe(false);
    expect(
      isValidMedicationRecord({ ...medication, currentPills: '20' })
    ).toBe(false);
    expect(
      isValidMedicationRecord({
        ...medication,
        doseSchedule: [{ ...medication.doseSchedule[0], amount: 0 }],
      })
    ).toBe(false);
  });

  it('accepts a valid log and rejects malformed log entries', () => {
    expect(isValidConsumptionLogRecord(log)).toBe(true);
    expect(isValidConsumptionLogRecord(null)).toBe(false);
    expect(
      isValidConsumptionLogRecord({ ...log, amount: '1' })
    ).toBe(false);
    expect(
      isValidConsumptionLogRecord({ ...log, type: 'unknown' })
    ).toBe(false);
  });
});
