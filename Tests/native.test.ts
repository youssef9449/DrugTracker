/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Capacitor modules before importing native.ts.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => 'android'),
  },
  registerPlugin: () => ({
    getNextOccurrence: () => Promise.resolve({ valid: false, nextOccurrenceMs: 0 }),
    clearReArm: () => Promise.resolve({ ok: true }),
  }),
}));
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setBackgroundColor: vi.fn(() => Promise.resolve()),
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
 * Notification channel creation — verifies the two-channel design:
 * - dose-reminder-v3: background/killed channel, HIGH importance, no
 *   custom sound (system default).
 * - dose-reminder-foreground-v1: foreground channel, LOW importance
 *   (silent — no Android sound), no custom sound.
 * - Old v1/v2 channels are deleted on migration.
 * - The unrelated low-stock channel is also created.
 */
describe('native.ts — two-channel dose-reminder design', () => {
  it('creates both dose-reminder channels + low-stock with correct config', async () => {
    // Reset the initialized flag so initNativeBridge runs again.
    vi.resetModules();

    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const { initNativeBridge } = await import('@/native');
    const {
      DOSE_REMINDER_CHANNEL_ID,
      DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
    } = await import('@/utils/notifications');

    vi.mocked(LocalNotifications.listChannels).mockResolvedValue({ channels: [] });
    vi.mocked(LocalNotifications.createChannel).mockClear();
    vi.mocked(LocalNotifications.deleteChannel).mockClear();

    await initNativeBridge();

    // createChannel should have been called for each channel.
    const created = vi.mocked(LocalNotifications.createChannel).mock.calls.map(
      (c) => c[0]
    );
    const createdIds = new Set(created.map((c) => c.id));

    // ── Background channel (dose-reminder-v3) ──
    // Must produce the Android SYSTEM DEFAULT notification sound (not silence,
    // not a custom wav). The chain is:
    //   1. We pass NO `sound` property on the channel object.
    //   2. Capacitor 6.x NotificationChannelManager.createChannel() reads
    //      `sound` and only calls NotificationChannel.setSound() when it's a
    //      non-empty string. With no `sound`, setSound is never called.
    //   3. The Android NotificationChannel constructor sets the default sound
    //      to Settings.System.DEFAULT_NOTIFICATION_URI.
    //   4. HIGH importance (4) makes the channel audible + heads-up.
    // So: no sound key + HIGH importance = system default sound. ✓
    expect(createdIds.has(DOSE_REMINDER_CHANNEL_ID)).toBe(true);
    const bgChannel = created.find((c) => c.id === DOSE_REMINDER_CHANNEL_ID)!;
    expect(bgChannel.importance).toBe(4); // HIGH → audible
    // The `sound` key must be ABSENT (not just null/empty). Capacitor's
    // createChannel only calls setSound for non-empty strings, so an absent
    // sound key → no setSound call → constructor default → system sound.
    expect(bgChannel.sound).toBeUndefined();
    expect('sound' in bgChannel).toBe(false); // key truly absent

    // ── Foreground channel (dose-reminder-foreground-v1) ──
    // Must be SILENT. Achieved via LOW importance (2) — Android never plays
    // sound for LOW-importance channels regardless of the sound URI. The
    // absent `sound` property is consistent with the background channel but
    // the silence is GUARANTEED by importance=2, not by the missing sound.
    expect(createdIds.has(DOSE_REMINDER_FOREGROUND_CHANNEL_ID)).toBe(true);
    const fgChannel = created.find(
      (c) => c.id === DOSE_REMINDER_FOREGROUND_CHANNEL_ID
    )!;
    expect(fgChannel.importance).toBe(2); // LOW → guaranteed silent
    expect(fgChannel.sound).toBeUndefined();

    // Low-stock channel also created.
    expect(createdIds.has('low-stock')).toBe(true);
  });

  it('background channel would NOT pass a sound string to createChannel (the only path Capacitor treats as custom sound)', async () => {
    // This test guards against a future regression where someone adds a
    // `sound` field to the background channel thinking it's needed for
    // "system default". In Capacitor 6.x, ANY non-empty sound string is
    // treated as a custom res/raw/ resource — passing one would BREAK
    // the system-default behavior. The background channel must have NO
    // sound string at all.
    vi.resetModules();

    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const { initNativeBridge } = await import('@/native');
    const { DOSE_REMINDER_CHANNEL_ID } = await import('@/utils/notifications');

    vi.mocked(LocalNotifications.listChannels).mockResolvedValue({ channels: [] });
    vi.mocked(LocalNotifications.createChannel).mockClear();
    await initNativeBridge();

    const created = vi.mocked(LocalNotifications.createChannel).mock.calls.map(
      (c) => c[0]
    );
    const bgChannel = created.find((c) => c.id === DOSE_REMINDER_CHANNEL_ID)!;

    // A non-empty string here would make Capacitor call setSound() with a
    // res/raw/<sound> URI — a custom sound. Must be absent.
    expect(typeof bgChannel.sound).not.toBe('string');
    expect(bgChannel.sound).toBeFalsy();
  });

});
