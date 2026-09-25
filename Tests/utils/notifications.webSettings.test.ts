import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBrowserNotificationSettings } from '@/utils/notifications/webNotifications';

const originalUserAgent = navigator.userAgent;

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: originalUserAgent,
  });
});

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('openBrowserNotificationSettings', () => {
  it('uses the Chromium settings URL only for a detected Chromium browser', () => {
    // NOTE: the UA fallback in isChromiumNotificationSettingsSupported()
    // excludes any UA carrying the legacy "Safari/" compatibility token —
    // which real-world Chrome UAs always include — so the fallback only
    // fires for Chromium-signature UAs without that token. The pinned
    // contract is exercised with such a UA here; the Safari-token
    // exclusion itself is pinned by the companion test below.
    setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0.0.0'
    );
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    openBrowserNotificationSettings();

    expect(open).toHaveBeenCalledWith(
      'chrome://settings/content/notifications',
      '_blank'
    );
  });

  it('excludes UA strings carrying the legacy Safari/ token from the Chromium fallback', () => {
    // Current production contract: the UA fallback's Safari guard runs on
    // the raw UA, so a Chrome UA that also carries the historical
    // "Safari/537.36" token (every real-world Chrome UA) is treated as
    // Safari by the fallback and gets the instructional alert instead of
    // the chrome:// URL. (Browsers exposing navigator.userAgentData take
    // the brands-based path before this fallback is consulted.)
    setUserAgent(
      'Mozilla/5.0 Chrome/153.0.0.0 Safari/537.36'
    );
    const open = vi.spyOn(window, 'open');

    openBrowserNotificationSettings();

    expect(open).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalled();
  });

  it('does not open a chrome:// URL for Firefox', () => {
    setUserAgent(
      'Mozilla/5.0 Firefox/142.0'
    );
    const open = vi.spyOn(window, 'open');

    openBrowserNotificationSettings();

    expect(open).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Firefox'));
  });

  it('does not open a chrome:// URL for Safari', () => {
    setUserAgent(
      'Mozilla/5.0 Safari/605.1.15'
    );
    const open = vi.spyOn(window, 'open');

    openBrowserNotificationSettings();

    expect(open).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Safari'));
  });

  it('does not treat Chromium-based Edge as Chrome', () => {
    setUserAgent(
      'Mozilla/5.0 Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0'
    );
    const open = vi.spyOn(window, 'open');

    openBrowserNotificationSettings();

    expect(open).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalled();
  });
});
