import { useEffect, useMemo, useRef } from 'react';
import type { Medication } from '../types';
import { getTodayDateString, getCriticalAlarmDate } from '../utils/dateCalculations';
import { scheduleCriticalAlarm, cancelCriticalAlarm } from '../utils/notifications';
import {
  loadCriticalTransitions,
  loadScheduledCriticalAlarms,
  saveScheduledCriticalAlarms,
  loadOwnershipRevisions,
  saveOwnershipRevisions,
  captureSchedulingContext,
  isSchedulingContextStillValid,
  canScheduleForTransition,
  bumpEpisodeOwnershipRevision,
  updateScheduledAlarm,
  invalidateScheduledAlarm,
  clearScheduledAlarm,
  type SchedulingOwnershipContext,
} from '../utils/criticalTransitions';

/**
 * The stored generation (scheduler-write revision) of a med's scheduled
 * record, or 0 when the med has no record yet. Used by the CANCEL-side
 * operations (opt-out, already-critical cancel, deleted-med cleanup),
 * which only ever REMOVE claims — their writes are generation-checked
 * so they can never erase a newer scheduler write. The SCHEDULE path
 * uses the full ownership context instead (captureSchedulingContextForMed).
 */
function readRecordGeneration(medId: string): number {
  return loadScheduledCriticalAlarms()[medId]?.generation ?? 0;
}

/**
 * Capture the medication's immutable scheduling ownership context from
 * the CURRENT authoritative stores (transition identity + notification
 * ownership + ownership revision + record revision/binding).
 *
 * MUST be called BEFORE the operation's first await — before any async
 * native bridge work — so the captured context describes the state the
 * operation is acting on. After the native work resolves, the context
 * is re-verified (isSchedulingContextStillValid) and the operation may
 * only persist scheduled state if it still matches.
 */
function captureSchedulingContextForMed(medId: string): SchedulingOwnershipContext {
  return captureSchedulingContext(
    loadCriticalTransitions(),
    loadScheduledCriticalAlarms(),
    loadOwnershipRevisions(),
    medId
  );
}

/**
 * Re-verify a captured ownership context against the CURRENT
 * authoritative stores. Returns false when ANY ownership-relevant
 * state moved under the operation (episode ended / new episode began /
 * notification ownership changed / med deleted / newer scheduler
 * write) — in that case the operation is stale and must not write
 * persistent scheduled state.
 */
function isSchedulingContextStillValidForMed(context: SchedulingOwnershipContext): boolean {
  return isSchedulingContextStillValid(
    context,
    loadCriticalTransitions(),
    loadScheduledCriticalAlarms(),
    loadOwnershipRevisions()
  );
}

/**
 * Options for {@link useCriticalAlarmScheduler}.
 */
export interface UseCriticalAlarmSchedulerOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
}

/**
 * One-shot critical-alarm scheduling effect.
 *
 * For each medication, computes the projected calendar date the med
 * will cross the critical threshold (getCriticalAlarmDate) and
 * schedules a SINGLE one-shot notification at that date via Android's
 * AlarmManager (Capacitor LocalNotifications). The alarm fires even if
 * the app is killed — the user sees the alert in their drawer at the
 * projected critical date without ever opening the app.
 *
 * == Identity separation (IMPORTANT) ==
 * This hook is a SCHEDULER, not an episode owner. It NEVER creates,
 * adopts, or derives a critical transition identity — the transitionKey
 * parameter that used to be generated here from criticalDateMs was the
 * root cause of unstable episode identities and has been removed.
 * criticalDateMs is scheduling data, NOT identity:
 *   transitionKey = identity of the critical episode  (owned by
 *                    useStockAlerts via criticalTransitions.ts)
 *   alarmTime     = projected time for the notification (owned HERE,
 *                    may change many times during one episode)
 *
 * Scheduled-record write rules (enforced by the helpers in
 * criticalTransitions.ts — this hook cannot bypass them):
 *   - Every storage operation captures the FULL ownership context
 *     (record generation + active episode identity + notification
 *     ownership state + per-med ownership revision + record binding)
 *     BEFORE the async native work and re-verifies it AFTER; a stale
 *     context ABANDONS every persistent write (and cancels the native
 *     alarm this operation armed) — including on the FAILURE/CATCH
 *     paths, so a stale operation can never erase a newer claim or
 *     touch a newer episode.
 *   - A successful schedule binds the claim to the CURRENTLY ACTIVE
 *     transition (READ from the authoritative store — never generated
 *     here), so a re-schedule can never erase an active episode's
 *     binding and never resurrect a dead one. With no active episode
 *     the claim is written unbound ('') and is adopted/bound by the
 *     episode owner at the actual crossing (see reconcileCriticalEpisode).
 *   - An episode whose notification was already consumed — SENT, or
 *     FIRED_OR_DUE (the owning claim's firing window passed, delivery
 *     unknown) — never regains a SCHEDULED claim (canScheduleForTransition
 *     pre-arm check + the helper's refusal rules).
 *
 * == Decision table (per med, per effect run) ==
 *
 *   Med sufficient, projected future crossing (criticalDateMs ≠ null):
 *     cancel old native alarm → schedule at the projected time →
 *     persist the claim ONLY after success ('refused' write ⇒ cancel
 *     the just-armed orphan alarm). This path never re-arms a consumed
 *     claim FOR AN ACTIVE EPISODE (sufficient meds have no episode);
 *     a consumed claim left over from a dead episode is dropped, and
 *     the new alarm is a genuinely new opportunity for a not-yet-begun
 *     episode.
 *
 *   Med critical / frozen (criticalDateMs = null):
 *     NEVER schedule (there is no future crossing to warn about — the
 *     foreground owner handles the active episode), and never re-arm
 *     a due/past claim. Two cancel paths keep no stale armed alarm
 *     alive:
 *       - same-session: a med this session armed an alarm for is
 *         cancelled when its projection disappears;
 *       - cross-session: an episode already in the SENT state gets its
 *         armed native alarm cancelled (the foreground consumed the
 *         episode's notification; an alarm left over from a previous
 *         session could only ever fire a SECOND user-facing
 *         notification for the same episode).
 *     An episode in the FIRED_OR_DUE (or pre-consumption SCHEDULED)
 *     state keeps its armed alarm untouched: a one-shot AlarmManager
 *     alarm fires at most once, so it IS the episode's single remaining
 *     notification opportunity — cancelling it would drop the
 *     episode's only notification, re-arming it would duplicate it.
 *     The episode owner consumes the claim (FIRED_OR_DUE) and positive
 *     drawer evidence upgrades it to SENT.
 *
 * Re-schedule triggers: this effect re-runs (and re-schedules every
 * med's alarm) whenever any field that affects the critical date
 * changes:
 *   - med.id (a med was added or deleted — must cancel old, schedule new)
 *   - med.currentPills (snapshot changed via refill/consume/restore)
 *   - med.dailyDose (changed via edit — settlement handled in save)
 *   - med.lastSyncDate (changed via refill/consume/settlement)
 *   - med.warningThresholdDays (drives the critical threshold)
 *   - med.autoDeductEnabled (pausing freezes the projected crossing)
 *
 * Gating:
 *   - Skip entirely before hydration (don't schedule for seed data).
 *   - Skip when criticalStockAlertsEnabled is false (user opted out).
 *   - Skip when notificationsEnabled is false (no permission to show).
 *
 * Race protection — stale-async guard + per-med serialization +
 * ownership-context verification:
 *   cancelCriticalAlarm() and scheduleCriticalAlarm() are async (they
 *   go through Capacitor's bridge). Both operate on the SAME stable
 *   native notification id (`criticalAlarmId(medId)`), so an older
 *   generation's compensating cancel would remove a newer generation's
 *   already-placed alarm if the two operations interleave freely.
 *
 *   Three layers of protection:
 *
 *   A) PER-MED SERIALIZATION (the core fix). All cancel/schedule
 *      operations for a given med are chained onto a per-med Promise
 *      (`alarmChainRef.get(medId)`). Each effect run APPENDS its
 *      cancel+schedule+compensating-cancel to this chain, so they run
 *      strictly in order — a newer generation's operations wait for
 *      the older generation's full chain (including its compensating
 *      cancel) to complete first. This guarantees an older
 *      generation's compensating cancel runs BEFORE the newer
 *      generation's schedule, so it can only remove the older
 *      generation's OWN stale alarm — never the newer one.
 *
 *   B) GENERATION COUNTER (scheduler-vs-scheduler). Even with
 *      serialization, we keep the per-med generation counter
 *      (`alarmGenerationRef`):
 *        1. Each effect run bumps the generation for every med it touches.
 *        2. Pre-schedule check: if a newer run bumped the gen, skip
 *           the schedule call (no point placing an alarm that will
 *           just be superseded).
 *        3. Post-schedule check: after schedule() resolves, re-check
 *           the gen; if it changed during the await, run a
 *           compensating cancel to undo this stale schedule. Because
 *           of (A), this compensating cancel runs BEFORE any newer
 *           generation's schedule, so it can only remove this
 *           generation's OWN alarm.
 *        4. Deleting a med bumps its generation, so any in-flight
 *           schedule from a prior run for that med bails out (or is
 *           re-canceled per step 3 if it already completed).
 *
 *   C) OWNERSHIP-CONTEXT VERIFICATION (scheduler-vs-episode-owner).
 *      The generation counter only answers "is this scheduler
 *      operation newer than another scheduler operation?" — it does
 *      NOT detect episode-owner lifecycle changes (episode ended, new
 *      episode began, notification ownership changed, med deleted),
 *      because those do not bump the record generation. Therefore
 *      every operation captures a SchedulingOwnershipContext
 *      (captureSchedulingContext) BEFORE its async native work and
 *      verifies it (isSchedulingContextStillValid) after: any mismatch
 *      means the operation is operating on a dead/changed ownership
 *      context, so it abandons all persistent writes and cancels the
 *      native alarm it armed. Deleting a medication additionally bumps
 *      the ownership revision synchronously (bumpEpisodeOwnershipRevision).
 *
 *   The combination guarantees: only the LATEST generation's schedule
 *   for the CURRENT episode ownership survives, an older generation's
 *   compensating cancel can NEVER remove a newer generation's alarm
 *   (because serialization orders the older compensating cancel BEFORE
 *   the newer schedule), and no stale operation can resurrect a dead
 *   episode's claim or restore notification ownership after it was
 *   consumed.
 *
 * Boot persistence — Android reboot:
 *   The @capacitor/local-notifications plugin persists scheduled
 *   notifications to SharedPreferences and re-arms them on
 *   BOOT_COMPLETED via its LocalNotificationRestoreReceiver. So our
 *   scheduled one-shot critical alarms survive device reboots without
 *   the user opening the app — no extra code or BootReceiver needed.
 *
 *   If for some reason the boot receiver doesn't fire (e.g. the app
 *   was force-stopped before the reboot), the user opening the app
 *   triggers this effect (re-arms all alarms) as a fallback.
 */
export function useCriticalAlarmScheduler({
  medications,
  notificationsEnabled,
  criticalStockAlertsEnabled,
  hydrated,
  isFirstRun,
}: UseCriticalAlarmSchedulerOptions): void {
  // Track previously-scheduled med ids so we can cancel alarms for
  // deleted meds (the medications array no longer contains them).
  const scheduledCriticalIdsRef = useRef<Set<string>>(new Set());
  // Per-med generation counter for stale-async race protection.
  // Each effect run bumps the value for the med it touches; the
  // .then() callback captures the value at effect-run time and bails
  // if a newer run bumped it.
  const alarmGenerationRef = useRef<Map<string, number>>(new Map());
  // Per-med serialization chain. Each effect run APPENDS its
  // cancel+schedule+compensating-cancel to this Promise so they run
  // strictly in order. This guarantees an older generation's
  // compensating cancel runs BEFORE a newer generation's schedule,
  // so the older cancel can only remove the older generation's OWN
  // alarm — never the newer one. Without this, the older
  // compensating cancel (which uses the SAME stable notification id
  // as the newer schedule) could remove the newer alarm if it ran
  // AFTER the newer schedule completed.
  const alarmChainRef = useRef<Map<string, Promise<void>>>(new Map());

  // #91: keep the latest medications in a ref so the effect can read the
  // current array without depending on the array reference (which changes
  // on every App render — even unrelated state like typing in a search
  // field — causing 3N async bridge calls per render).
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // #91: stable signature capturing ONLY the fields that affect the
  // critical alarm date (per getCriticalAlarmDate + scheduleCriticalAlarm):
  //   id, currentPills, dailyDose, lastSyncDate, warningThresholdDays,
  //   autoDeductEnabled, name, unit.
  // warningThresholdDays IS the user-configured threshold (no derived
  // sub-threshold). The effect is gated on this string so the full
  // cancel+schedule chain only re-runs when a med's alarm-relevant
  // config actually changes.
  const criticalSignature = useMemo(
    () =>
      medications
        .map((m) =>
          [
            m.id,
            m.currentPills,
            m.dailyDose,
            m.lastSyncDate ?? '',
            m.warningThresholdDays,
            m.autoDeductEnabled === false ? 0 : 1,
            m.name,
            m.unit ?? '',
          ].join('|')
        )
        .sort()
        .join('\n'),
    [medications]
  );

  /**
   * Append an async operation to the per-med chain and return the
   * new chain tail. The operation runs only after any previously-
   * chained operation for this med completes.
   */
  const enqueue = (medId: string, op: () => Promise<void>): Promise<void> => {
    const prev = alarmChainRef.current.get(medId) ?? Promise.resolve();
    const next = prev.then(op, op); // run op whether prev resolved or rejected
    alarmChainRef.current.set(medId, next);
    // Swallow rejection on the stored tail so it doesn't surface as
    // an unhandled rejection. The caller of enqueue() can still hang
    // .then/.catch off the returned `next` if they want to observe
    // the result.
    next.catch(() => void 0);
    return next;
  };

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    // User opted out of either flag → cancel all previously-scheduled
    // alarms and clear the tracker. Also bump generations so any
    // in-flight schedule from a prior effect run is stale. The cancels
    // are enqueued per-med so they serialize against any in-flight
    // operations from prior generations (e.g. an older generation's
    // schedule that hasn't placed its alarm yet — its compensating
    // cancel will run AFTER this opt-out cancel, but it'll be a
    // no-op because the alarm was already removed).
    if (!notificationsEnabled || !criticalStockAlertsEnabled) {
      scheduledCriticalIdsRef.current.forEach((id) => {
        alarmGenerationRef.current.set(
          id,
          (alarmGenerationRef.current.get(id) ?? 0) + 1
        );
        enqueue(id, async () => {
          const baselineGen = readRecordGeneration(id);
          await cancelCriticalAlarm(id);
          const records = loadScheduledCriticalAlarms();
          if (invalidateScheduledAlarm(records, id, baselineGen)) {
            saveScheduledCriticalAlarms(records);
          }
        });
      });
      scheduledCriticalIdsRef.current.clear();
      return;
    }

    const today = getTodayDateString();
    const stillScheduled = new Set<string>();

    for (const med of medicationsRef.current) {
      const gen = (alarmGenerationRef.current.get(med.id) ?? 0) + 1;
      alarmGenerationRef.current.set(med.id, gen);

      const criticalDateMs = getCriticalAlarmDate(med, today);
      if (criticalDateMs === null) {
        // No future crossing to arm: the med is critical (the foreground
        // owner handles the active episode) or frozen. NEVER schedule here,
        // and never re-arm a due/past claim — that would duplicate the
        // notification of an episode whose claim already consumed its
        // firing window.
        if (scheduledCriticalIdsRef.current.has(med.id)) {
          enqueue(med.id, async () => {
            const baselineGen = readRecordGeneration(med.id);
            await cancelCriticalAlarm(med.id);
            const records = loadScheduledCriticalAlarms();
            if (invalidateScheduledAlarm(records, med.id, baselineGen)) {
              saveScheduledCriticalAlarms(records);
            }
          });
        }
        // Cross-session staleness: an alarm armed by a PREVIOUS session
        // for an episode whose notification the foreground has already
        // consumed (SENT) can only ever fire a SECOND user-facing
        // notification for the same episode — cancel it. Episodes whose
        // claim is FIRED_OR_DUE (or still SCHEDULED pre-consumption)
        // keep their armed alarm: it is the episode's single remaining
        // opportunity and fires at most once. Cancel is idempotent and
        // writes no persistent state, so no ownership context is needed.
        enqueue(med.id, async () => {
          const t = loadCriticalTransitions()[med.id];
          if (t && t.notificationState === 'SENT') {
            await cancelCriticalAlarm(med.id);
          }
        });
        continue;
      }

      // A future projected crossing only — the med is still sufficient,
      // so NO active transition exists yet and none may be created here.
      // The claim is persisted (after schedule success) via
      // updateScheduledAlarm: bound to the active transition when one
      // exists (read-only), otherwise unbound. useStockAlerts binds/
      // adopts it when the episode actually begins. alarmTime below is
      // pure scheduling data.
      const unit = med.unit || 'قرص';
      const name = med.name;

      stillScheduled.add(med.id);

      enqueue(med.id, async () => {
        // Capture the FULL ownership context BEFORE any async native
        // work: record generation + active episode identity + notification
        // ownership state + per-med ownership revision + record binding.
        // After the native work resolves, the context is re-verified and
        // this operation may only persist scheduled state if it still
        // matches. A generation check alone would miss episode-owner
        // lifecycle changes (they do not bump the record generation).
        const context = captureSchedulingContextForMed(med.id);

        await cancelCriticalAlarm(med.id);
        if (alarmGenerationRef.current.get(med.id) !== gen) return;

        // Relevance check (pre-arm): if the active episode's notification
        // was already consumed — SENT, or FIRED_OR_DUE (the owning
        // claim's firing window passed) — a new native alarm must not be
        // armed at all; it could only ever become a second user-facing
        // notification for an episode whose single notification
        // opportunity was spent. (Sufficient meds have no active episode,
        // so this is defense-in-depth for the state machine; the cancel
        // above already cleaned up any stale armed alarm.)
        if (!canScheduleForTransition(loadCriticalTransitions(), med.id)) return;

        try {
          const scheduledResult = await scheduleCriticalAlarm(
            med.id,
            name,
            criticalDateMs,
            unit
          );

          if (alarmGenerationRef.current.get(med.id) !== gen) {
            await cancelCriticalAlarm(med.id);
            // Stale-generation compensation: only abandon THIS
            // operation's own alarm state. A persistent write is only
            // allowed when the ownership context is still valid — a
            // stale operation must never erase a newer claim.
            if (isSchedulingContextStillValidForMed(context)) {
              const records = loadScheduledCriticalAlarms();
              if (invalidateScheduledAlarm(records, med.id, context.baselineRecordGeneration)) {
                saveScheduledCriticalAlarms(records);
              }
            }
            return;
          }

          // Ownership-context check (scheduler-vs-episode-owner): if
          // the episode ended, a new episode began, the notification
          // ownership changed, or the medication was deleted while this
          // operation awaited the bridge, its captured context is stale.
          // It must NOT recreate or mutate the scheduled claim — that
          // would resurrect a dead episode's claim or restore
          // notification ownership after it was consumed. Cancel the
          // native alarm this operation armed so it can never fire for
          // an episode it does not belong to, and leave the persistent
          // scheduled state to the CURRENT owner.
          if (
            !isSchedulingContextStillValidForMed(context) ||
            !medicationsRef.current.some((m) => m.id === med.id)
          ) {
            await cancelCriticalAlarm(med.id);
            return;
          }

          // Persist the scheduled-claim record ONLY after the native
          // schedule actually succeeded. A failure leaves no valid
          // SCHEDULED claim, which keeps the foreground notification
          // path available in useStockAlerts.
          //
          // updateScheduledAlarm re-reads the CURRENT record and the
          // authoritative active transition at write time: it preserves
          // the active episode's binding, drops dead/stale bindings,
          // refuses consumed episodes/claims (SENT / FIRED_OR_DUE), and
          // stamps the new generation. It can neither erase a valid
          // binding nor resurrect an old identity.
          if (scheduledResult !== false) {
            const records = loadScheduledCriticalAlarms();
            const write = updateScheduledAlarm(records, loadCriticalTransitions(), med.id, {
              alarmTime: criticalDateMs,
              baselineGeneration: context.baselineRecordGeneration,
              now: Date.now(),
            });
            if (write === 'persisted') {
              saveScheduledCriticalAlarms(records);
            } else if (write === 'refused') {
              // The write was refused by an ownership/consumption rule.
              // The alarm this operation just armed has NO valid claim
              // behind it — it could only ever fire an unclaimed
              // notification. Cancel it so it can never survive as an
              // orphan.
              await cancelCriticalAlarm(med.id);
            }
            // 'unchanged': the record already held exactly this
            // scheduling data; the re-armed alarm matches its claim.
          } else {
            // Native scheduling failed → no valid SCHEDULED claim. The
            // foreground path stays available. A stale operation must
            // not touch the persistent state at all (the current owner
            // decides what the state means now).
            if (!isSchedulingContextStillValidForMed(context)) return;
            const records = loadScheduledCriticalAlarms();
            if (
              invalidateScheduledAlarm(records, med.id, context.baselineRecordGeneration)
            ) {
              saveScheduledCriticalAlarms(records);
            }
          }
        } catch (err) {
          console.warn('[critical-alarm] schedule failed:', err);
          // Ownership-safe failure path: a stale operation must not
          // invalidate a newer episode's claim or erase a newer
          // scheduler write. Only the still-valid owner of this context
          // may neutralize its own record.
          if (!isSchedulingContextStillValidForMed(context)) return;
          const records = loadScheduledCriticalAlarms();
          if (invalidateScheduledAlarm(records, med.id, context.baselineRecordGeneration)) {
            saveScheduledCriticalAlarms(records);
          }
        }
      });
    }

    // Cancel alarms for meds that are no longer scheduled (deleted, or
    // the projected crossing no longer exists). Bump their in-memory
    // generation AND their persistent ownership revision SYNCHRONOUSLY
    // so any in-flight schedule from a previous run bails out / becomes
    // ownership-stale before it can persist a claim for a medication
    // that no longer exists. The enqueued cleanup then serializes
    // against in-flight ops and removes the native alarm + record.
    for (const prevId of scheduledCriticalIdsRef.current) {
      if (!stillScheduled.has(prevId)) {
        alarmGenerationRef.current.set(
          prevId,
          (alarmGenerationRef.current.get(prevId) ?? 0) + 1
        );
        const revisions = loadOwnershipRevisions();
        if (bumpEpisodeOwnershipRevision(revisions, prevId)) {
          saveOwnershipRevisions(revisions);
        }
        enqueue(prevId, async () => {
          const baselineGen = readRecordGeneration(prevId);
          await cancelCriticalAlarm(prevId);
          const records = loadScheduledCriticalAlarms();
          if (clearScheduledAlarm(records, prevId, baselineGen)) {
            saveScheduledCriticalAlarms(records);
          }
        });
      }
    }
    scheduledCriticalIdsRef.current = stillScheduled;
  }, [
    criticalSignature,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
  ]);
}
