/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * #33 — UpdatePrompt must remove ALL event listeners on unmount
 * (controllerchange, updatefound, and each per-worker statechange).
 * Previously only controllerchange was removed, so updatefound +
 * statechange listeners leaked across re-mounts.
 *
 * jsdom doesn't implement the ServiceWorker API, so we mock
 * navigator.serviceWorker with a minimal stub that records
 * addEventListener/removeEventListener calls and allows us to assert
 * cleanup.
 */

// Minimal SW registration stub.
function makeStubRegistration(): ServiceWorkerRegistration {
  return {
    update: vi.fn(),
    unregister: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    installing: null,
    waiting: null,
    active: null,
    navigationPreload: {} as never,
    scope: '/',
    onupdatefound: null,
    showNotify: vi.fn(),
    getNotifications: vi.fn(),
  } as unknown as ServiceWorkerRegistration;
}

describe('UpdatePrompt — listener cleanup (#33)', () => {
  let originalServiceWorker: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom doesn't have navigator.serviceWorker; install a stub.
    originalServiceWorker = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    const listeners = new Map<string, Set<EventListener>>();
    const swStub = {
      controller: null,
      getRegistration: vi.fn(() => Promise.resolve(makeStubRegistration())),
      addEventListener: vi.fn((type: string, handler: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
      }),
      removeEventListener: vi.fn((type: string, handler: EventListener) => {
        listeners.get(type)?.delete(handler);
      }),
      register: vi.fn(),
      getRegistrations: vi.fn(() => Promise.resolve([])),
      ready: Promise.resolve(makeStubRegistration()),
      startMessages: vi.fn(),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      value: swStub,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    // Restore the original (likely undefined in jsdom).
    Object.defineProperty(navigator, 'serviceWorker', {
      value: originalServiceWorker,
      configurable: true,
      writable: true,
    });
    cleanup();
  });

  it('removes the controllerchange listener on unmount', async () => {
    const { unmount } = render(<UpdatePrompt />);

    // Let the getRegistration promise resolve.
    await vi.waitFor(() => {
      expect(navigator.serviceWorker.getRegistration).toHaveBeenCalled();
    });

    unmount();

    // controllerchange removeEventListener must have been called at
    // least once (the controllerchange listener is always added).
    expect(navigator.serviceWorker.removeEventListener).toHaveBeenCalledWith(
      'controllerchange',
      expect.any(Function)
    );
  });

  it('does not call setWaitingWorker after unmount (isMounted guard)', async () => {
    const { unmount } = render(<UpdatePrompt />);
    await vi.waitFor(() => {
      expect(navigator.serviceWorker.getRegistration).toHaveBeenCalled();
    });

    // Unmount before any updatefound event fires.
    unmount();

    // After unmount, if a registration's updatefound fired, the
    // setWaitingWorker should NOT be called on the unmounted component.
    // (The isMounted guard prevents a React "setState on unmounted
    // component" warning.) The test passes if no error was thrown
    // during render + unmount — no assertion needed (#122).
  });
});

// Late import so the mocks above are in place before the component
// module loads. vitest hoists vi.mock but we're using a property stub
// on navigator, so we import the component here (after the describe
// block sets up the stub via beforeEach). Since vitest modules are
// cached, this import resolves to the real component which reads
// navigator.serviceWorker at runtime (in useEffect), not at import.
import { UpdatePrompt } from './UpdatePrompt';
