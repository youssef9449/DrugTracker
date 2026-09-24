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
    setUserAgent(
      'Mozilla/5.0 Chrome/153.0.0.0 Safari/537.36'
    );
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    openBrowserNotificationSettings();

    expect(open).toHaveBeenCalledWith(
      'chrome://settings/content/notifications',
      '_blank'
    );
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
