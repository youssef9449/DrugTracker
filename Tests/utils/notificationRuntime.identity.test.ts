import { requireDefined } from '../helpers/requireDefined';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => 'android'),
  nativePost: vi.fn(),
  nativeCancel: vi.fn(),
  nativeCheckPermission: vi.fn(),
  nativeAddListener: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  getPending: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: mocks.platform,
  },
  registerPlugin: () => ({
    post: mocks.nativePost,
    cancel: mocks.nativeCancel,
    checkPermission: mocks.nativeCheckPermission,
    addListener: mocks.nativeAddListener,
  }),
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: mocks.schedule,
    cancel: mocks.cancel,
    checkPermissions: mocks.checkPermissions,
    getPending: mocks.getPending,
  },
}));

import {
  scheduleNotification,
  cancelNotification,
  getPendingNotificationResult,
  postNativeNotification,
} from '@/utils/notificationRuntime';

const baseOptions = {
  namespace: 'dose-reminder',
  identity: 'med-1::dose-morning',
  title: 'Test',
  body: 'Test body',
  channelId: 'dose-reminder-v3',
  channelName: 'Dose Reminder',
  channelImportance: 4 as const,
  smallIcon: 'ic_launcher',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue('android');
  mocks.nativePost.mockResolvedValue({ ok: true });
  mocks.nativeCancel.mockResolvedValue({ ok: true });
  mocks.nativeCheckPermission.mockResolvedValue({ enabled: true });
  mocks.schedule.mockResolvedValue({ notifications: [] });
  mocks.cancel.mockResolvedValue(undefined);
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.getPending.mockResolvedValue({ notifications: [] });
});

describe('notification logical identity boundary', () => {
  it('Android sends namespace + logical identity to NotificationRuntime with no numeric feature id', async () => {
    await postNativeNotification(baseOptions);

    expect(mocks.nativePost).toHaveBeenCalledTimes(1);
    const payload = requireDefined(mocks.nativePost.mock.calls[0], 'mocks.nativePost.mock.calls[0]')[0];

    expect(payload.namespace).toBe('dose-reminder');
    expect(payload.identity).toBe('med-1::dose-morning');
    expect('id' in payload).toBe(false);
  });

  it('iOS keeps the logical namespace + identity as the authority while hiding the platform numeric handle', async () => {
    mocks.platform.mockReturnValue('ios');

    await scheduleNotification(baseOptions);
    await scheduleNotification(baseOptions);

    expect(mocks.schedule).toHaveBeenCalledTimes(2);

    const firstCall = requireDefined(mocks.schedule.mock.calls[0], 'mocks.schedule.mock.calls[0]');
    const secondCall = requireDefined(mocks.schedule.mock.calls[1], 'mocks.schedule.mock.calls[1]');
    const firstRequest = requireDefined(firstCall[0], 'firstCall[0]');
    const secondRequest = requireDefined(secondCall[0], 'secondCall[0]');
    const first = requireDefined(firstRequest.notifications[0], 'firstRequest.notifications[0]');
    const second = requireDefined(secondRequest.notifications[0], 'secondRequest.notifications[0]');

    expect(first.id).toBe(second.id);
    expect(first.extra.namespace).toBe('dose-reminder');
    expect(first.extra.identity).toBe('med-1::dose-morning');
  });

  it('different logical notification identities are independently addressable', async () => {
    mocks.platform.mockReturnValue('ios');

    await scheduleNotification(baseOptions);
    await scheduleNotification({
      ...baseOptions,
      identity: 'med-1::dose-evening',
    });
    await scheduleNotification({
      ...baseOptions,
      namespace: 'critical-stock',
      identity: 'med-1',
    });

    const ids = mocks.schedule.mock.calls.map(
      (call) => call[0].notifications[0].id
    );

    expect(new Set(ids).size).toBe(3);
  });

  it('cancel uses only namespace + logical identity', async () => {
    await cancelNotification('critical-stock', 'med-1');

    expect(mocks.nativeCancel).toHaveBeenCalledTimes(1);
    expect(mocks.nativeCancel).toHaveBeenCalledWith({
      namespace: 'critical-stock',
      identity: 'med-1',
    });
  });

  it('iOS cancel resolves the same platform handle as schedule without exposing it to callers', async () => {
    mocks.platform.mockReturnValue('ios');

    await scheduleNotification(baseOptions);
    const scheduleRequest = requireDefined(
      requireDefined(mocks.schedule.mock.calls[0], 'mocks.schedule.mock.calls[0]')[0],
      'schedule request'
    );
    const scheduledNotification = requireDefined(
      scheduleRequest.notifications[0],
      'scheduled notification'
    );
    const scheduledId = scheduledNotification.id;

    await cancelNotification(
      baseOptions.namespace,
      baseOptions.identity
    );

    expect(mocks.cancel).toHaveBeenCalledWith({
      notifications: [{ id: scheduledId }],
    });
  });

  it('iOS pending lookup resolves a logical identity without requiring callers to know numeric ids', async () => {
    mocks.platform.mockReturnValue('ios');

    await scheduleNotification(baseOptions);
    const scheduledId =
      requireDefined(mocks.schedule.mock.calls[0], 'mocks.schedule.mock.calls[0]')[0].requireDefined(notifications[0], 'notifications[0]').id;

    mocks.getPending.mockResolvedValue({
      notifications: [
        {
          id: scheduledId,
          schedule: { at: new Date('2026-09-21T12:00:00.000Z') },
        },
      ],
    });

    const result = await getPendingNotificationResult(
      baseOptions.namespace,
      baseOptions.identity
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.pending).not.toBeNull();
      expect(result.pending?.schedule?.at).toEqual(
        new Date('2026-09-21T12:00:00.000Z')
      );
    }
  });
});
