/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePersistentEffect } from './usePersistentEffect';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePersistentEffect', () => {
  it('does NOT write when enabled is false (hydration gate)', () => {
    const showToast = vi.fn();
    renderHook(() =>
      usePersistentEffect({
        storageKey: 'k',
        value: { a: 1 },
        enabled: false,
        showToast,
      })
    );
    expect(localStorage.getItem('k')).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('writes JSON to localStorage when enabled is true', () => {
    renderHook(() =>
      usePersistentEffect({
        storageKey: 'k',
        value: { a: 1 },
        enabled: true,
      })
    );
    expect(localStorage.getItem('k')).toBe('{"a":1}');
  });

  it('writes a raw string when json:false', () => {
    renderHook(() =>
      usePersistentEffect({
        storageKey: 'k',
        value: 'true',
        json: false,
        enabled: true,
      })
    );
    expect(localStorage.getItem('k')).toBe('true');
  });

  it('writes again when the value changes', () => {
    const { rerender } = renderHook(
      ({ value }) =>
        usePersistentEffect({ storageKey: 'k', value, enabled: true }),
      { initialProps: { value: { a: 1 } } }
    );
    expect(localStorage.getItem('k')).toBe('{"a":1}');

    rerender({ value: { a: 2 } });
    expect(localStorage.getItem('k')).toBe('{"a":2}');
  });

  it('shows the toast ONCE on quota failure (warned-ref dedup)', () => {
    const showToast = vi.fn();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      const { rerender } = renderHook(
        ({ value }) =>
          usePersistentEffect({
            storageKey: 'k',
            value,
            enabled: true,
            failureMessage: 'قد لا يتم حفظ البيانات.',
            showToast,
          }),
        { initialProps: { value: { a: 1 } } }
      );
      // First failure toasts once.
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith(
        'مساحة التخزين ممتلئة — قد لا يتم حفظ البيانات.'
      );

      // Re-render with a new value — the warned-ref prevents a 2nd toast.
      rerender({ value: { a: 2 } });
      expect(showToast).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('clears the warned-ref on success so a future failure can toast again', () => {
    const showToast = vi.fn();
    let shouldThrow = false;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      if (shouldThrow) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
    });
    try {
      const { rerender } = renderHook(
        ({ value }) =>
          usePersistentEffect({
            storageKey: 'k',
            value,
            enabled: true,
            failureMessage: 'msg',
            showToast,
          }),
        { initialProps: { value: { a: 1 } } }
      );
      // First write succeeds — no toast.
      expect(showToast).not.toHaveBeenCalled();

      // Second write fails — toasts once.
      shouldThrow = true;
      rerender({ value: { a: 2 } });
      expect(showToast).toHaveBeenCalledTimes(1);

      // Third write succeeds again — warned-ref cleared.
      shouldThrow = false;
      rerender({ value: { a: 3 } });
      expect(showToast).toHaveBeenCalledTimes(1);

      // Fourth write fails again — toasts again (ref was cleared).
      shouldThrow = true;
      rerender({ value: { a: 4 } });
      expect(showToast).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('debounces the write when debounceMs > 0', () => {
    vi.useFakeTimers();
    try {
      renderHook(() =>
        usePersistentEffect({
          storageKey: 'k',
          value: { a: 1 },
          enabled: true,
          debounceMs: 400,
        })
      );
      // Before the debounce timer fires, nothing is written.
      expect(localStorage.getItem('k')).toBeNull();
      vi.advanceTimersByTime(399);
      expect(localStorage.getItem('k')).toBeNull();
      vi.advanceTimersByTime(1);
      expect(localStorage.getItem('k')).toBe('{"a":1}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the pending debounced write on unmount', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() =>
        usePersistentEffect({
          storageKey: 'k',
          value: { a: 1 },
          enabled: true,
          debounceMs: 400,
        })
      );
      unmount();
      vi.advanceTimersByTime(1000);
      expect(localStorage.getItem('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to console.warn when no showToast is provided', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      renderHook(() =>
        usePersistentEffect({
          storageKey: 'k',
          value: { a: 1 },
          enabled: true,
          failureMessage: 'msg',
          // no showToast — should console.warn instead
        })
      );
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
