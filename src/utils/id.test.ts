import { describe, it, expect, vi } from 'vitest';
import { generateId } from './id';

describe('generateId', () => {
  it('returns a string starting with the given prefix + hyphen', () => {
    expect(generateId('log')).toMatch(/^log-/);
    expect(generateId('refill')).toMatch(/^refill-/);
    expect(generateId('consume')).toMatch(/^consume-/);
    expect(generateId('restore')).toMatch(/^restore-/);
    expect(generateId('refill-undo')).toMatch(/^refill-undo-/);
  });

  it('produces unique ids on successive calls (no collision in 1000 draws)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId('log'));
    }
    expect(ids.size).toBe(1000);
  });

  it('produces different ids for different prefixes', () => {
    const a = generateId('log');
    const b = generateId('refill');
    expect(a).not.toBe(b);
    expect(a.startsWith('log-')).toBe(true);
    expect(b.startsWith('refill-')).toBe(true);
  });

  it('the uuid fallback path is never reached in the test env (crypto.randomUUID exists)', () => {
    // crypto.randomUUID is available in jsdom (Node 19+ / Vitest jsdom env),
    // so the generated id should be prefix + a 36-char uuid v4.
    const id = generateId('log');
    // 'log-' (4) + 36-char uuid = 40
    expect(id).toHaveLength(40);
    // uuid v4 shape: 8-4-4-4-12
    expect(id.slice(4)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('falls back to Date.now()+random when crypto.randomUUID is unavailable', () => {
    // Replace the global `crypto` with a minimal stub that lacks
    // randomUUID, to exercise the fallback branch. jsdom's crypto is
    // non-configurable, so we use vi.stubGlobal to swap the binding.
    const realCrypto = crypto;
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    try {
      const id = generateId('log');
      expect(id).toMatch(/^log-\d+-[a-z0-9]+$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handles an empty prefix gracefully (edge case)', () => {
    // An empty prefix still yields a unique id with a leading hyphen.
    // Nobody passes '' in practice, but the helper shouldn't crash.
    const id = generateId('');
    expect(id.startsWith('-')).toBe(true);
  });
});