import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    openAppSettings: vi.fn(),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: mocks.app,
}));

import { openNativeAppSettings } from '@/utils/nativeAppSettings';

beforeEach(() => {
  mocks.app.openAppSettings.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openNativeAppSettings', () => {
  it('returns true when the native App plugin opens settings', async () => {
    mocks.app.openAppSettings.mockResolvedValue(undefined);

    await expect(openNativeAppSettings()).resolves.toBe(true);
    expect(mocks.app.openAppSettings).toHaveBeenCalledTimes(1);
  });

  it('returns false when the native capability rejects', async () => {
    mocks.app.openAppSettings.mockRejectedValue(new Error('unsupported'));

    await expect(openNativeAppSettings()).resolves.toBe(false);
  });

  it('returns false when the optional native capability is unavailable', async () => {
    const original = mocks.app.openAppSettings;
    delete (mocks.app as { openAppSettings?: unknown }).openAppSettings;
    await expect(openNativeAppSettings()).resolves.toBe(false);
    (mocks.app as { openAppSettings?: unknown }).openAppSettings = original;
  });
});
