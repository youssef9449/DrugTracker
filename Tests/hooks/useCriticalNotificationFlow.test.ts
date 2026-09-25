/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { getTodayDateString, getCriticalAlarmDate } from '@/utils/dateCalculations';
import { CRITICAL_CLAIMS_STORAGE_KEY } from '@/utils/criticalNotificationClaims';
import { useStockAlerts } from '@/hooks/useStockAlerts';
import { useCriticalAlarmScheduler } from '@/hooks/useCriticalAlarmScheduler';
import type { CriticalAlarmOperationResult } from '@/utils/criticalAlarmScheduling';

// Integration tests: both hooks mounted together, exactly like App.tsx
// wires them (useStockAlerts first, then useCriticalAlarmScheduler).
// These verify the END-TO-END business rule: at most ONE critical-stock
// notification per continuous Critical/Out-of-Stock episode, with no
// duplicates across restarts, early crossings, or refill cycles.
//
// OWNERSHIP INVARIANT: useStockAlerts owns the claim's business
// lifecycle SYNCHRONOUSLY (Sufficient ⇒ claim cleared on that very
// render); the scheduler only executes native alarms and may write a
// claim as the outcome of a successful future schedule. The race tests
// below pin this: an in-flight async scheduler operation must never be
// able to silence or erase a NEW episode's claim.

// Mutable platform mock so tests can switch between the web and the
// native (android) code paths.
const platformMock = vi.hoisted(() => vi.fn(() => 'web'));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: platformMock },
  registerPlugin: () => ({
    getNextOccurrence: () => Promise.resolve({ valid: false, nextOccurrenceMs: 0 }),
    clearReArm: () => Promise.resolve({ ok: true }),
  }),
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: vi.fn(),
    cancel: vi.fn(),
    checkPermissions: vi.fn(),
    checkExactNotificationSetting: vi.fn(),
    getPending: vi.fn(),
  },
}));

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  verify: vi.fn(),
  list: vi.fn(),
}));

// Both hooks import the production source modules directly, so the mocks
// must be installed on those module ids (mocking the test facade would
// not intercept production calls).
vi.mock('@/utils/notifications/criticalStockNotifications', () => ({
  sendCriticalStockAlert: mocks.send,
}));
vi.mock('@/utils/criticalAlarmScheduling', () => ({
  scheduleCriticalAlarm: mocks.schedule,
  cancelCriticalAlarm: mocks.cancel,
  verifyCriticalAlarmPending: mocks.verify,
}));
vi.mock('@/utils/criticalAlarmNative', () => ({
  listScheduledCriticalMedicationIdsNative: mocks.list,
}));

import { sendCriticalStockAlert } from '@/utils/notifications/criticalStockNotifications';
import { installWebLocksShim, type WebLocksShimHandle } from '../helpers/webLocksShim';

// #484: foreground claim acquisition requires the cross-document Web Lock;
// tests install an explicit Web Locks test double (fail-closed without it).
let locksShim: WebLocksShimHandle | null = null;
import { readCriticalClaims as readClaims } from '../helpers/criticalStockClaims';

const sendMock = vi.mocked(sendCriticalStockAlert);
const scheduleMock = vi.mocked(mocks.schedule);
const cancelMock = vi.mocked(mocks.cancel);
const verifyMock = mocks.verify;

function makeMed(overrides: Partial<Medication> = {}): Medication {
  const dailyDose = overrides.dailyDose ?? 1;
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    // The unified critical-stock policy requires the per-medication flag
    // to be explicitly ON before any delivery/scheduling decision.
    criticalStockAlertsEnabled: true,
    // The crossing projection reads the explicit dose schedule; mirror
    // dailyDose so status semantics are unchanged.
    doseSchedule: [{ id: 'd1', amount: dailyDose, time: '20:00' }],
    ...overrides,
  };
}

function useBothHooks(props: {
  medications: Medication[];
  criticalStockAlertsEnabled?: boolean;
  resumeTick?: number;
}) {
  useStockAlerts({
    medications: props.medications,
    criticalStockAlertsEnabled: props.criticalStockAlertsEnabled ?? true,
    hydrated: true,
    isFirstRun: false,
  });
  useCriticalAlarmScheduler({
    medications: props.medications,
    criticalStockAlertsEnabled: props.criticalStockAlertsEnabled ?? true,
    hydrated: true,
    isFirstRun: false,
    // Web-mocked platform: exact-alarm capability is not applicable, which
    // lets the scheduler proceed (only null / 'denied' gate scheduling).
    exactAlarmPermission: 'unsupported',
    resumeTick: props.resumeTick ?? 0,
  });
}

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  locksShim = installWebLocksShim();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  platformMock.mockReturnValue('web');
  sendMock.mockResolvedValue(true);
  scheduleMock.mockResolvedValue({ ok: true });
  cancelMock.mockResolvedValue({ ok: true });
  verifyMock.mockReset();
  verifyMock.mockResolvedValue({ ok: true, pending: false });
  // Native durable schedule listing: nothing armed in a fresh test run.
  mocks.list.mockReset();
  mocks.list.mockResolvedValue({ ok: true, ids: [] });
});

afterEach(() => {
  locksShim?.uninstall();
  locksShim = null;
  cleanup();
  vi.useRealTimers();
});

describe('critical notification flow — both hooks integrated', () => {
  it('sufficient → alarm armed → early crossing → exactly ONE notification, no duplicates', async () => {
    const sufficient = makeMed({ currentPills: 30 });
    const projectedT = getCriticalAlarmDate(sufficient, getTodayDateString()) as number;

    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient] },
    });
    await flush();

    // The scheduler armed the future alarm and claimed it; the
    // foreground sent nothing (med is sufficient).
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: projectedT });
    expect(sendMock).not.toHaveBeenCalled();

    // Early crossing (manual consumption) while the alarm is still
    // future: the alarm-relevant change runs BOTH hooks' effects in the
    // same commit. The scheduler's cleanup (cancel of the stale armed
    // alarm) bumps the per-medication alarm generation, which supersedes
    // THIS commit's foreground delivery pass (#539) — the in-flight
    // foreground claim is released and the opportunity re-opens.
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    rerender({ medications: [critical] });
    await flush();

    expect(sendMock).not.toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });

    // The re-opened opportunity is delivered by the NEXT reconciliation
    // pass (the scheduler effect is signature-skipped here, so nothing
    // invalidates this one): exactly one notification for the episode.
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Re-renders while still critical (same episode) never duplicate.
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('alarm fired while the app was closed → app restart → NO duplicate', async () => {
    // State as left by a previous session: the med crossed, the scheduled
    // alarm's window passed (fired while the app was closed or missed).
    localStorage.setItem(
      CRITICAL_CLAIMS_STORAGE_KEY,
      JSON.stringify({ 'med-1': { claimed: true, alarmTime: Date.now() - 3_600_000 } })
    );
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });

    // First launch after the restart.
    const first = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [critical] },
    });
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    first.unmount();

    // Repeated restarts stay quiet too.
    const second = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [critical] },
    });
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    second.unmount();
  });

  it('critical → refill → critical again: exactly one NEW notification for the new episode', async () => {
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    const { rerender } = renderHook<void, { medications: Medication[]; resumeTick?: number }>(
      (props) => useBothHooks(props),
      {
        initialProps: { medications: [critical] },
      }
    );
    await flush();
    // Cold-start pass: the scheduler's same-commit per-medication
    // generation bump supersedes this pass's foreground delivery (#539);
    // the claim is released for the next pass.
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1); // episode 1 notified
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Refill → sufficient. The consumed foreground claim is released
    // synchronously (foreground owns the episode end); the scheduler's
    // snapshot on THIS pass still sees the consumed claim, so it defers
    // re-arming (never arms a competing fallback while the foreground
    // claim is unsettled).
    const refilled = makeMed({ currentPills: 40, warningThresholdDays: 5 });
    rerender({ medications: [refilled] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1); // no duplicate on refill
    expect(scheduleMock).not.toHaveBeenCalled(); // re-arm deferred on this pass
    expect(readClaims()['med-1']).toBeUndefined();

    // A later reconciliation pass (here: an app resume tick) finds no
    // blocking claim and re-arms the next projected crossing; the claim
    // transfers to the scheduled alarm.
    const nextT = getCriticalAlarmDate(refilled, getTodayDateString()) as number;
    rerender({ medications: [refilled], resumeTick: 1 });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1); // no duplicate on refill
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: nextT });

    // Stock drops into the critical zone again → new episode → the
    // still-future claimed alarm is released; the crossing commit's own
    // foreground pass is superseded by the scheduler's cleanup (#539),
    // and the next pass delivers exactly one new notification.
    const criticalAgain = makeMed({ currentPills: 4, warningThresholdDays: 5 });
    rerender({ medications: [criticalAgain] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    rerender({ medications: [{ ...criticalAgain }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Still critical → quiet.
    rerender({ medications: [{ ...criticalAgain }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('scheduler/foreground race: a med that crosses while its schedule is in flight produces at most one notification', async () => {
    // Simulate the race window: the scheduler's schedule call resolves
    // AFTER the medications array already shows the med critical.
    let resolveSchedule: (v: CriticalAlarmOperationResult) => void = () => undefined;
    scheduleMock.mockImplementationOnce(
      () =>
        new Promise<CriticalAlarmOperationResult>((resolve) => {
          resolveSchedule = resolve;
        })
    );

    const sufficient = makeMed({ currentPills: 30 });
    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient] },
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    // The med crosses while the schedule is still pending. The
    // foreground hook runs on this render, but the scheduler's same-commit
    // cleanup (it can no longer own a scheduling decision for a critical
    // med) supersedes the pass (#539): the in-flight claim is released,
    // nothing is sent yet, and the opportunity re-opens.
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    rerender({ medications: [critical] });
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });

    // The in-flight schedule now resolves — stale. The scheduler must
    // not overwrite the foreground's re-opened claim.
    resolveSchedule({ ok: true });
    await flush();

    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    // The scheduler compensated by cancelling the alarm it armed.
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    // Still exactly one user-facing notification: the next pass delivers.
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('BLOCKER RACE: Critical → Sufficient → Critical before async cleanup resolves still notifies exactly once', async () => {
    // 1. Episode A: Critical → the foreground sends once and claims
    // (delivery lands on the second pass — see #539 in test 1).
    const criticalA = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    const { rerender } = renderHook<void, { medications: Medication[]; resumeTick?: number }>(
      (props) => useBothHooks(props),
      {
        initialProps: { medications: [criticalA] },
      }
    );
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(0);
    rerender({ medications: [{ ...criticalA }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // 2. Refill → Sufficient. The consumed foreground claim is released
    // synchronously; the scheduler's same-pass snapshot still sees it and
    // defers re-arming, so the follow-up schedule must be triggered by a
    // later reconciliation pass (resume tick). It is gated there so no
    // async operation can COMPLETE before episode B starts.
    let resolveSchedule: (v: CriticalAlarmOperationResult) => void = () => undefined;
    scheduleMock.mockImplementationOnce(
      () =>
        new Promise<CriticalAlarmOperationResult>((resolve) => {
          resolveSchedule = resolve;
        })
    );
    const sufficient = makeMed({ currentPills: 40, warningThresholdDays: 5 });
    rerender({ medications: [sufficient] });
    await flush();
    expect(scheduleMock).not.toHaveBeenCalled(); // deferred (foreground claim unsettled)
    expect(readClaims()['med-1']).toBeUndefined();

    // The reconciliation pass arms the follow-up schedule — in flight.
    rerender({ medications: [sufficient], resumeTick: 1 });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1); // in flight, unresolved

    // 3. The claim stays cleared — it does not wait for the still-pending
    // native schedule (foreground owns the episode end). This is the
    // ownership that makes step 4 safe.
    expect(readClaims()['med-1']).toBeUndefined();

    // 4. The user consumes pills again BEFORE the old async operation
    // resolves. Episode B must NOT inherit episode A's claim: the
    // foreground sees no claim → its delivery pass runs (the crossing
    // commit's own pass is superseded by the scheduler's cleanup bump,
    // #539 — the claim is released and the next pass delivers exactly
    // ONE new notification).
    const criticalB = makeMed({ currentPills: 4, warningThresholdDays: 5 });
    rerender({ medications: [criticalB] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    rerender({ medications: [{ ...criticalB }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // 5. Resolve the old async operation. It must NOT remove the new
    // claim, flip it to claimed=false, or write any stale state.
    resolveSchedule({ ok: true });
    await flush();

    // 6. Final expected claim: episode B's, untouched.
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
    expect(sendMock).toHaveBeenCalledTimes(2);

    // Still critical → quiet (episode B already consumed its chance).
    rerender({ medications: [{ ...criticalB }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('BLOCKER RACE (future-alarm variant): a Sufficient render clears the claim synchronously and the pending native cancel cannot erase episode B\u2019s claim', async () => {
    // State at the end of episode A: the refill happened while an alarm
    // armed for episode A's early crossing was still pending — a
    // still-future claim that no longer belongs to any live episode.
    localStorage.setItem(
      CRITICAL_CLAIMS_STORAGE_KEY,
      JSON.stringify({ 'med-1': { claimed: true, alarmTime: Date.now() + 24 * 60 * 60 * 1000 } })
    );

    // Gate the native cancel so the "old cancellation" stays in flight.
    // (The flush below lets the enqueued cancel START — capturing the
    // real promise resolver — while the cancel itself stays pending.)
    let resolveCancel: () => void = () => undefined;
    cancelMock.mockImplementationOnce(
      () =>
        new Promise<CriticalAlarmOperationResult>((resolve) => {
          resolveCancel = () => resolve({ ok: true });
        })
    );

    const sufficient = makeMed({ currentPills: 40, warningThresholdDays: 5 });
    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient] },
    });

    // Let the render's synchronous claim-clear decision (and its durable
    // write) land while the native cancel is still gated/pending.
    await flush();
    // The claim is cleared by this render — it does not wait for the
    // still-pending native cancel (foreground owns the episode end).
    expect(readClaims()['med-1']).toBeUndefined();

    // The queued cancel op actually STARTED (pending, unresolved).
    expect(cancelMock).toHaveBeenCalledTimes(1);

    // Episode B starts BEFORE the native cancel resolves: the foreground
    // finds no claim → its delivery pass runs for episode B. The crossing
    // commit's own pass is superseded by the scheduler's cleanup bump
    // (#539); the next pass delivers exactly ONE notification.
    const criticalB = makeMed({ currentPills: 4, warningThresholdDays: 5 });
    rerender({ medications: [criticalB] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    rerender({ medications: [{ ...criticalB }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // The old cancellation resolves — it must not erase episode B's
    // claim, un-claim it, or recreate stale state.
    resolveCancel();
    await flush();

    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The stale episode-A alarm was cancelled through the queue.
    expect(cancelMock).toHaveBeenCalledWith('med-1');

    // Still critical → quiet.
    rerender({ medications: [{ ...criticalB }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('BLOCKER (native alarm disappearance): matching claim + missing native alarm → silent repair, no duplicate foreground', async () => {
    // State as left by a previous session: the alarm was armed at T
    // (claimed) — but the OS dropped it (exact-alarm revoked, notification
    // removed, …). The app reopens: the claim must NOT be treated as
    // proof that the alarm exists.
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue({ ok: true, pending: false }); // getPending has no alarm at T
    const sufficient = makeMed({ currentPills: 40, warningThresholdDays: 5 });
    const projectedT = getCriticalAlarmDate(sufficient, getTodayDateString()) as number;
    localStorage.setItem(
      CRITICAL_CLAIMS_STORAGE_KEY,
      JSON.stringify({ 'med-1': { claimed: true, alarmTime: projectedT } })
    );

    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient] },
    });
    await flush();

    // The scheduler repaired the claim by re-arming the SAME alarm time.
    expect(verifyMock).toHaveBeenCalledWith('med-1', projectedT);
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', projectedT, 'قرص');
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: projectedT });
    // Reconciliation is silent for the user: the med is sufficient, so
    // no foreground notification was sent (and none is due yet).
    expect(sendMock).not.toHaveBeenCalled();

    // The med crosses later → the (re-armed) future claim is released;
    // the crossing commit's own foreground pass is superseded by the
    // scheduler's cleanup bump (#539) and the next pass fires exactly ONE
    // notification for this episode.
    const critical = makeMed({ currentPills: 4, warningThresholdDays: 5 });
    rerender({ medications: [critical] });
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });

  it('BLOCKER (resume reconciliation): app resume re-verifies matching claims against the platform and repairs quietly', async () => {
    platformMock.mockReturnValue('android');
    const sufficient = makeMed({ currentPills: 30, warningThresholdDays: 5 });
    const projectedT = getCriticalAlarmDate(sufficient, getTodayDateString()) as number;

    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient], resumeTick: 0 },
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: projectedT });
    expect(sendMock).not.toHaveBeenCalled();

    // The alarm disappeared while the app was backgrounded.
    verifyMock.mockResolvedValue({ ok: true, pending: false });

    // Resume: App.tsx bumps the tick → reconciliation runs. The alarm
    // is missing → repaired at the same T, silently.
    rerender({ medications: [sufficient], resumeTick: 1 });
    await flush();

    expect(verifyMock).toHaveBeenCalledWith('med-1', projectedT);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: projectedT });
    // No user-facing notification just because reconciliation happened.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('BLOCKER (repair failure): native scheduling failure opens the claim and the foreground fallback still notifies exactly once', async () => {
    // The claim says armed at T, but the native alarm is gone AND the
    // repair cannot re-arm it. The claim must open — and when the med
    // crosses, the foreground (not a phantom alarm) delivers the ONE
    // episode notification.
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue({ ok: true, pending: false });
    scheduleMock.mockResolvedValue({ ok: false, error: 'schedule_failed', errorCode: 'platform_failure' }); // repair fails (e.g. permission revoked)
    const sufficient = makeMed({ currentPills: 40, warningThresholdDays: 5 });
    const projectedT = getCriticalAlarmDate(sufficient, getTodayDateString()) as number;
    localStorage.setItem(
      CRITICAL_CLAIMS_STORAGE_KEY,
      JSON.stringify({ 'med-1': { claimed: true, alarmTime: projectedT } })
    );

    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient] },
    });
    await flush();

    // No false armed claim: the opportunity is open again.
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    expect(sendMock).not.toHaveBeenCalled(); // still sufficient — nothing sent yet

    // The med crosses → the open claim lets the foreground own the
    // episode. The crossing commit's own pass is superseded by the
    // scheduler's cleanup bump (#539); the next pass delivers exactly
    // once.
    const critical = makeMed({ currentPills: 4, warningThresholdDays: 5 });
    rerender({ medications: [critical] });
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Still critical → quiet.
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
