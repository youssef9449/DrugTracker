import { describe, expect, it, vi } from 'vitest';

const getPlatform = vi.hoisted(() => vi.fn(() => 'android'));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform },
}));

import {
  getNativePlatform,
  isAndroidPlatform,
  isIosPlatform,
  isNativePlatform,
} from '../../src/utils/platform';

describe('platform helpers', () => {
  it('detects Android as the canonical native platform', () => {
    getPlatform.mockReturnValue('android');

    expect(getNativePlatform()).toBe('android');
    expect(isAndroidPlatform()).toBe(true);
    expect(isIosPlatform()).toBe(false);
    expect(isNativePlatform()).toBe(true);
  });

  it('detects iOS as the canonical native platform', () => {
    getPlatform.mockReturnValue('ios');

    expect(getNativePlatform()).toBe('ios');
    expect(isAndroidPlatform()).toBe(false);
    expect(isIosPlatform()).toBe(true);
    expect(isNativePlatform()).toBe(true);
  });

  it('treats web as non-native', () => {
    getPlatform.mockReturnValue('web');

    expect(getNativePlatform()).toBeNull();
    expect(isAndroidPlatform()).toBe(false);
    expect(isIosPlatform()).toBe(false);
    expect(isNativePlatform()).toBe(false);
  });

  it('fails closed when platform detection throws', () => {
    getPlatform.mockImplementation(() => {
      throw new Error('platform unavailable');
    });

    expect(getNativePlatform()).toBeNull();
    expect(isAndroidPlatform()).toBe(false);
    expect(isIosPlatform()).toBe(false);
    expect(isNativePlatform()).toBe(false);
  });
});
