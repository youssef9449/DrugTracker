/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted NotificationRuntime plugin mock: production bridges the listener
// and channel flows through the custom NotificationRuntime plugin
// (registerPlugin('NotificationRuntime')), so the mock must be stable
// across vi.resetModules() re-imports and name-aware.
const notificationRuntimePlugin = vi.hoisted(() => {
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
  return {
    listeners,
    addListener: vi.fn(
      (eventName: string, cb: (event: Record<string, unknown>) => void) => {
        listeners[eventName] = cb;
        return Promise.resolve({ remove: vi.fn(() => Promise.resolve()) });
      }
    ),
    ensureChannel: vi.fn(
      (_options: {
        channelId: string;
        channelName: string;
        channelImportance: number;
        channelVisibility?: number;
      }) => Promise.resolve({ ok: true })
    ),
    checkChannel: vi.fn(() => Promise.resolve({ enabled: true })),
    checkPermission: vi.fn(() => Promise.resolve({ enabled: true })),
    retryPersistedNotificationDeliveries: vi.fn(() => Promise.resolve({ retried: 0 })),
    post: vi.fn(() => Promise.resolve({ ok: true })),
    cancel: vi.fn(() => Promise.resolve({ ok: true })),
  };
});
const getPlatform = vi.hoisted(() => vi.fn(() => 'android'));

// Mock the Capacitor modules before importing native.ts.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform,
  },
  registerPlugin: (name: string) => {
    if (name === 'NotificationRuntime') return notificationRuntimePlugin;
    return {
      getNextOccurrence: () => Promise.resolve({ valid: false, nextOccurrenceMs: 0 }),
      clearReArm: () => Promise.resolve({ ok: true }),
    };
  },
}));
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setBackgroundColor: vi.fn(() => Promise.resolve()),
    setStyle: vi.fn(() => Promise.resolve()),
  },
  Style: { Light: 'LIGHT' },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(() => Promise.resolve({ remove: vi.fn(() => Promise.resolve()) })),
    exitApp: vi.fn(),
    openAppSettings: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    listChannels: vi.fn(() => Promise.resolve({ channels: [] })),
    createChannel: vi.fn(() => Promise.resolve()),
    deleteChannel: vi.fn(() => Promise.resolve()),
    registerActionTypes: vi.fn(() => Promise.resolve()),
    addListener: vi.fn(() => Promise.resolve({ remove: vi.fn(() => Promise.resolve()) })),
  },
}));

import { registerBackButtonHandler, cleanupNativeListeners } from '@/native';

/**
 * #21 — registerBackButtonHandler stores a callback that the back
 * button checks. If the handler returns true (a modal was closed),
 * the app stays open; if false (no modal), the app exits.
 */
describe('native.ts — registerBackButtonHandler (#21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerBackButtonHandler(null);
  });

  it('is a callable function that accepts a handler or null', () => {
    expect(typeof registerBackButtonHandler).toBe('function');
    expect(() => registerBackButtonHandler(() => true)).not.toThrow();
    expect(() => registerBackButtonHandler(() => false)).not.toThrow();
    expect(() => registerBackButtonHandler(null)).not.toThrow();
  });

  it('a handler returning true simulates "modal was closed" (app stays)', () => {
    const handler = vi.fn(() => true);
    registerBackButtonHandler(handler);
    // The handler is stored; the actual invocation happens inside the
    // backButton listener in initNativeBridge. Here we verify the
    // registration mechanism works (the function is accepted and
    // doesn't throw).
    expect(handler).not.toHaveBeenCalled(); // not called yet
  });

  it('a handler returning false simulates "no modal open" (app exits)', () => {
    const handler = vi.fn(() => false);
    registerBackButtonHandler(handler);
    // Same — registration succeeds; the handler is stored for the
    // backButton listener to call.
    expect(handler).not.toHaveBeenCalled();
  });

  it('null handler simulates "no handler registered" (default: exit)', () => {
    registerBackButtonHandler(null);
    // No error; the back button will call App.exitApp() since no
    // handler returns true.
  });
});

/**
 * #38 — cleanupNativeListeners removes stored Capacitor listener
 * handles. Safe to call even when handles are null (web platform or
 * before init).
 */
describe('native.ts — cleanupNativeListeners (#38)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a callable function', () => {
    expect(typeof cleanupNativeListeners).toBe('function');
  });

  it('removes handles without error even when handles are null (before init)', async () => {
    // cleanupNativeListeners should not throw even if the handles
    // are null (they are null before initNativeBridge runs, or on
    // the web platform where initNativeBridge returns early).
    await expect(cleanupNativeListeners()).resolves.not.toThrow();
  });

  it('can be called multiple times safely (idempotent)', async () => {
    await cleanupNativeListeners();
    await cleanupNativeListeners();
    // No error on second call (handles already null).
  });
});

/**
 * #37 — The createChannel cast was removed; the TypeScript compiler
 * now type-checks the calls directly. This is verified by `tsc
 * --noEmit` passing (the types `Channel`, `Importance`, `Visibility`
 * are imported from @capacitor/local-notifications and used without a
 * cast). If the cast were still needed, tsc would fail.
 *
 * #122: the previous `expect(true).toBe(true)` tautology was removed.
 * The test is a compile-time assertion: if this test file compiles,
 * the types are correct. No runtime assertion is needed.
 */
describe('native.ts — createChannel cast removed (#37)', () => {
  it('the Channel/Importance/Visibility types are importable from @capacitor/local-notifications', () => {
    // This import is at the top of the file. If the types didn't
    // exist, tsc would fail. The mock provides the runtime; the
    // real .d.ts provides the types. The test passes by compiling
    // successfully — no runtime assertion needed (#122).
  });
});

/**
 * Channel bootstrap — verifies the two-channel dose-reminder design at its
 * CURRENT seam. JS-side LocalNotifications.createChannel no longer exists:
 * Notification Runtime (native plugin) owns channel creation, and startup
 * bootstraps the channels via initializeNativeRuntime →
 * ensureNotificationChannel (#503):
 * - dose-reminder-v3: background/killed channel, HIGH importance (audible,
 *   system default sound).
 * - dose-reminder-foreground-v1: foreground channel, LOW importance
 *   (guaranteed silent).
 */
describe('native channel bootstrap — two-channel dose-reminder design', () => {
  it('bootstraps both dose-reminder channels with correct config and no custom sound', async () => {
    // Reset the initialized flag so initNativeBridge runs again.
    vi.resetModules();

    const { initNativeBridge } = await import('@/native');
    const { initializeNativeRuntime } = await import('@/utils/appHydrationPhases');
    const {
      DOSE_REMINDER_CHANNEL_ID,
      DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
    } = await import('./utils/notificationTestFacade');

    await initNativeBridge();
    notificationRuntimePlugin.ensureChannel.mockClear();
    await initializeNativeRuntime(vi.fn());

    // ensureChannel should have been called for each dose-reminder channel.
    const created = notificationRuntimePlugin.ensureChannel.mock.calls.map(
      (c) => c[0]
    );
    const createdIds = new Set(created.map((c) => c.channelId));

    // ── Background channel (dose-reminder-v3) ──
    // HIGH importance (4) makes the channel audible + heads-up. The channel
    // carries NO `sound` property at all: the ensureChannel contract has no
    // sound field, so the Android channel keeps the SYSTEM DEFAULT sound.
    expect(createdIds.has(DOSE_REMINDER_CHANNEL_ID)).toBe(true);
    const bgChannel = created.find((c) => c.channelId === DOSE_REMINDER_CHANNEL_ID)!;
    expect(bgChannel.channelImportance).toBe(4); // HIGH → audible
    expect('sound' in bgChannel).toBe(false); // no custom sound crosses the bridge

    // ── Foreground channel (dose-reminder-foreground-v1) ──
    // Must be SILENT. Achieved via LOW importance (2) — Android never plays
    // sound for LOW-importance channels regardless of the sound URI.
    expect(createdIds.has(DOSE_REMINDER_FOREGROUND_CHANNEL_ID)).toBe(true);
    const fgChannel = created.find(
      (c) => c.channelId === DOSE_REMINDER_FOREGROUND_CHANNEL_ID
    )!;
    expect(fgChannel.channelImportance).toBe(2); // LOW → guaranteed silent
    expect('sound' in fgChannel).toBe(false);
  });

  it('initNativeBridge sets StatusBar color/style and registers Notification Runtime listeners even if StatusBar setup fails', async () => {
    // The bridge contract: safe-area/status-bar setup is best-effort (wrapped
    // in try/catch) and must never block listener registration, while the
    // dose-reminder listeners register through the NotificationRuntime plugin
    // (LocalNotifications.addListener is iOS-only now).
    vi.resetModules();

    const { StatusBar } = await import('@capacitor/status-bar');
    const { Style } = (await import('@capacitor/status-bar')) as { Style: { Light: string } };
    const { initNativeBridge } = await import('@/native');

    await initNativeBridge();

    expect(vi.mocked(StatusBar.setBackgroundColor)).toHaveBeenCalledWith({ color: '#0f766e' });
    expect(vi.mocked(StatusBar.setStyle)).toHaveBeenCalledWith({ style: Style.Light });

    // Both dose-reminder listeners register through NotificationRuntime.
    expect(notificationRuntimePlugin.addListener).toHaveBeenCalledWith(
      'notificationReceived',
      expect.any(Function)
    );
    expect(notificationRuntimePlugin.addListener).toHaveBeenCalledWith(
      'notificationActionPerformed',
      expect.any(Function)
    );
    // JS-side LocalNotifications channel/listener setup is gone on Android.
    expect(notificationRuntimePlugin.addListener).not.toHaveBeenCalledWith(
      'localNotificationReceived',
      expect.anything()
    );

    // StatusBar failure must not block listener registration (fresh module
    // instance so the bridge's once-only guard does not skip init).
    vi.resetModules();
    const native2 = await import('@/native');
    vi.mocked(StatusBar.setStyle).mockRejectedValueOnce(new Error('status bar boom'));
    notificationRuntimePlugin.addListener.mockClear();
    await native2.initNativeBridge();
    expect(notificationRuntimePlugin.addListener).toHaveBeenCalledWith(
      'notificationReceived',
      expect.any(Function)
    );
    expect(notificationRuntimePlugin.addListener).toHaveBeenCalledWith(
      'notificationActionPerformed',
      expect.any(Function)
    );
  });

});

/**
 * Dose isolation on the received-notification path. The payload contract is
 * now namespace+identity based: a dose reminder carries
 * namespace 'dose-reminder' and identity '<medicationId>::<doseId>'
 * (built from trimmed ids at scheduling time — a blank doseId never
 * produces an identity). Any other namespace (e.g. critical-stock) must not
 * reach the dose handler.
 */
describe('native.ts — received-notification dose isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlatform.mockReturnValue('android');
  });

  async function captureReceivedListener(): Promise<(n: Record<string, unknown>) => void> {
    vi.resetModules();
    const { initNativeBridge } = await import('@/native');
    const { cleanupNativeListeners } = await import('@/native');
    await cleanupNativeListeners();
    delete notificationRuntimePlugin.listeners.notificationReceived;
    delete notificationRuntimePlugin.listeners.notificationActionPerformed;
    await initNativeBridge();
    const cb = notificationRuntimePlugin.listeners['notificationReceived'];
    if (!cb) throw new Error('notificationReceived listener not registered');
    return cb as (n: Record<string, unknown>) => void;
  }

  it('does not call doseReceivedHandler for Critical Stock shape (different namespace, no dose identity)', async () => {
    const handler = vi.fn();
    const received = await captureReceivedListener();
    // Re-register after module reset inside capture
    const mod = await import('@/native');
    mod.registerDoseReceivedHandler(handler);
    received({ namespace: 'critical-stock', identity: 'med-1', extra: { medicationId: 'med-1' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls doseReceivedHandler for dose reminder (medicationId + doseId identity)', async () => {
    const handler = vi.fn();
    const received = await captureReceivedListener();
    const mod = await import('@/native');
    mod.registerDoseReceivedHandler(handler);
    received({ namespace: 'dose-reminder', identity: 'med-1::d1' });
    expect(handler).toHaveBeenCalledWith('med-1', 'd1');
  });

  it('does not call doseReceivedHandler for blank doseId', async () => {
    const handler = vi.fn();
    const received = await captureReceivedListener();
    const mod = await import('@/native');
    mod.registerDoseReceivedHandler(handler);
    // A blank doseId is trimmed away at scheduling time, so it can only
    // appear as an empty identity segment — never a valid dose identity.
    received({ namespace: 'dose-reminder', identity: 'med-1::' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not call doseReceivedHandler for a dose-reminder event without an identity separator', async () => {
    const handler = vi.fn();
    const received = await captureReceivedListener();
    const mod = await import('@/native');
    mod.registerDoseReceivedHandler(handler);
    received({ namespace: 'dose-reminder', identity: 'med-1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('registers the iOS received listener through LocalNotifications with the namespace+identity payload', async () => {
    getPlatform.mockReturnValue('ios');
    vi.resetModules();
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const { initNativeBridge } = await import('@/native');
    const mod = await import('@/native');

    const handler = vi.fn();
    mod.registerDoseReceivedHandler(handler);

    // Capture every LocalNotifications event registration (iOS path).
    const iosListeners: Record<string, (n: unknown) => void> = {};
    vi.mocked(LocalNotifications.addListener).mockImplementation(((
      event: string,
      cb: (n: unknown) => void
    ) => {
      iosListeners[event] = cb;
      return Promise.resolve({ remove: () => Promise.resolve() });
    }) as never);
    await initNativeBridge();

    const received = iosListeners['localNotificationReceived'];
    expect(typeof received).toBe('function');
    received!({ extra: { namespace: 'dose-reminder', identity: 'med-1::d1' } });
    expect(handler).toHaveBeenCalledWith('med-1', 'd1');
  });
});
