import { describe, it, expect, afterEach } from 'vitest';
import { getInitialTab } from './initialTab';

/**
 * #17 — getInitialTab reads the `tab` query param from the URL so the
 * PWA manifest shortcuts (/?tab=stock, /?tab=logs, /?tab=shopping) land
 * on the correct tab.
 */
describe('getInitialTab (#17)', () => {
  const originalSearch = window.location.search;

  afterEach(() => {
    // Restore the original URL after each test.
    window.history.replaceState({}, '', originalSearch);
  });

  it('returns "stock" when no tab param is present', () => {
    window.history.replaceState({}, '', '/');
    expect(getInitialTab()).toBe('stock');
  });

  it('returns "stock" for ?tab=stock', () => {
    window.history.replaceState({}, '', '/?tab=stock');
    expect(getInitialTab()).toBe('stock');
  });

  it('returns "logs" for ?tab=logs', () => {
    window.history.replaceState({}, '', '/?tab=logs');
    expect(getInitialTab()).toBe('logs');
  });

  it('returns "shopping" for ?tab=shopping', () => {
    window.history.replaceState({}, '', '/?tab=shopping');
    expect(getInitialTab()).toBe('shopping');
  });

  it('returns "stock" for an invalid tab value', () => {
    window.history.replaceState({}, '', '/?tab=invalid');
    expect(getInitialTab()).toBe('stock');
  });

  it('returns "stock" for an empty tab param', () => {
    window.history.replaceState({}, '', '/?tab=');
    expect(getInitialTab()).toBe('stock');
  });

  it('returns the correct tab even with other params present', () => {
    window.history.replaceState({}, '', '/?foo=bar&tab=logs&baz=qux');
    expect(getInitialTab()).toBe('logs');
  });
});
