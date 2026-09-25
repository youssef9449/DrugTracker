import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readWebScheduledNotification,
  scheduleWebNotification,
} from '@/utils/notifications/webNotifications';

/**
 * #483 regression coverage: same-identity replacement of a scheduled Web
 * notification must re-arm the NEW definition (fireAt/title/body), the old
 * realization must never deliver the replaced notification, and the durable
 * localStorage record stays the application source of truth.
 */

class FakeNotification {
  static instances: Array<{ title: string; body?: string | undefined }> = [];
  static permission: NotificationPermission = 'granted';

  constructor(title: string, options?: NotificationOptions) {
    FakeNotification.instances.push({ title, body: options?.body });
  }

  close(): void {}
}

const T0 = Date.parse('2026-02-01T10:00:00');

beforeEach(() => {
  FakeNotification.instances.length = 0;
  FakeNotification.permission = 'granted';
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  // jsdom has no Notification constructor and no service worker: defining
  // window.Notification makes isWebNotificationSupported() true and forces
  // the page-timer fallback path with the synchronous constructor.
  vi.stubGlobal('Notification', FakeNotification);
  window.Notification =
    FakeNotification as unknown as typeof Notification;
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('#483 same-identity Web notification replacement', () => {
  it('replacement with a LATER fireAt re-arms: old instant stays silent, new one delivers once', async () => {
    const at1 = new Date(T0 + 60_000);
    expect(
      await scheduleWebNotification('old title', 'old body', {
        namespace: 't483',
        identity: 'later',
        at: at1,
      })
    ).toBe(true);

    vi.advanceTimersByTime(30_000); // T0+30s
    const at2 = new Date(T0 + 120_000);
    expect(
      await scheduleWebNotification('new title', 'new body', {
        namespace: 't483',
        identity: 'later',
        at: at2,
      })
    ).toBe(true);

    // Durable record is the source of truth: it now holds the replacement.
    const replaced = readWebScheduledNotification('t483', 'later');
    expect(replaced.status === 'ok' && replaced.value?.fireAt).toBe(
      at2.getTime()
    );
    expect(replaced.status === 'ok' && replaced.value?.title).toBe('new title');

    // Old instant passes with NO delivery of the replaced notification.
    vi.advanceTimersByTime(60_000); // T0+90s > at1
    expect(FakeNotification.instances).toHaveLength(0);
    // The replacement record survived the stale instant.
    expect(readWebScheduledNotification('t483', 'later').status).toBe('ok');

    // New instant: exactly one delivery with the new definition.
    vi.advanceTimersByTime(30_000); // T0+120s
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]).toMatchObject({
      title: 'new title',
      body: 'new body',
    });
    // Delivery consumed the durable record (terminal state).
    const consumed = readWebScheduledNotification('t483', 'later');
    expect(consumed.status === 'ok' && consumed.value).toBeNull();
  });

  it('replacement with an EARLIER fireAt delivers at the earlier instant and never at the old one', async () => {
    const late = new Date(T0 + 120_000);
    await scheduleWebNotification('late title', 'late body', {
      namespace: 't483',
      identity: 'earlier',
      at: late,
    });
    vi.advanceTimersByTime(10_000);
    const early = new Date(T0 + 45_000);
    expect(
      await scheduleWebNotification('early title', 'early body', {
        namespace: 't483',
        identity: 'earlier',
        at: early,
      })
    ).toBe(true);

    vi.advanceTimersByTime(35_000); // T0+45s == early
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]).toMatchObject({
      title: 'early title',
      body: 'early body',
    });

    // Old (now stale) instant must not deliver a second time.
    vi.advanceTimersByTime(120_000);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('replacement with changed title/body at the SAME fireAt delivers the new content exactly once', async () => {
    const at = new Date(T0 + 60_000);
    await scheduleWebNotification('first title', 'first body', {
      namespace: 't483',
      identity: 'content',
      at,
    });
    vi.advanceTimersByTime(5_000);
    expect(
      await scheduleWebNotification('second title', 'second body', {
        namespace: 't483',
        identity: 'content',
        at,
      })
    ).toBe(true);

    const record = readWebScheduledNotification('t483', 'content');
    expect(record.status === 'ok' && record.value?.title).toBe('second title');
    expect(record.status === 'ok' && record.value?.body).toBe('second body');

    vi.advanceTimersByTime(55_000); // due
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]).toMatchObject({
      title: 'second title',
      body: 'second body',
    });
  });

  it('a stale timer firing after replacement must not deliver the old notification', async () => {
    const at1 = new Date(T0 + 30_000);
    await scheduleWebNotification('stale title', 'stale body', {
      namespace: 't483',
      identity: 'stale-hop',
      at: at1,
    });
    vi.advanceTimersByTime(1_000);
    const at2 = new Date(T0 + 90_000);
    await scheduleWebNotification('fresh title', 'fresh body', {
      namespace: 't483',
      identity: 'stale-hop',
      at: at2,
    });

    // The OLD timer wakes at its original instant.
    vi.advanceTimersByTime(29_000); // T0+30s
    expect(FakeNotification.instances).toHaveLength(0);
    // Replacement record still pending — not consumed by the stale hop.
    const pending = readWebScheduledNotification('t483', 'stale-hop');
    expect(pending.status === 'ok' && pending.value?.fireAt).toBe(
      at2.getTime()
    );

    vi.advanceTimersByTime(60_000); // T0+90s
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]).toMatchObject({
      title: 'fresh title',
      body: 'fresh body',
    });
  });

  it('an IDENTICAL re-schedule stays idempotent and delivers exactly once', async () => {
    const at = new Date(T0 + 60_000);
    await scheduleWebNotification('same title', 'same body', {
      namespace: 't483',
      identity: 'idempotent',
      at,
    });
    await scheduleWebNotification('same title', 'same body', {
      namespace: 't483',
      identity: 'idempotent',
      at,
    });

    vi.advanceTimersByTime(60_000);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]).toMatchObject({
      title: 'same title',
    });
  });
});
