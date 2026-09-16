# Exact-Time Automatic Dose Deduction — Architecture

Current-state technical specification for DrugTracker’s exact-time automatic dose deduction. Behavior is defined by the implementation on the repository `main` line; this document is not a development history or changelog.

## Code map

| Concern | Primary location |
|---------|------------------|
| JS → native schedule / list / mark bridge | `src/utils/autoDeductionNative.ts` |
| JS schedule requests (post-hydration) | `src/hooks/useAutoDeductionScheduler.ts` |
| Native constants, occurrence key, PendingIntent URI | `native-android/auto-deduction/AutoDeductionContract.java` |
| Durable native event store | `AutoDeductionEventStore.java` |
| Exact alarm install / cancel / boot restore | `AutoDeductionScheduler.java` |
| Alarm + boot receiver | `AutoDeductionReceiver.java` |
| Capacitor plugin | `AutoDeductionPlugin.java` |
| Pure reconcile / apply | `src/utils/autoDeductionReconciliation.ts` |
| Orchestration, envelope, marks | `src/utils/runAutoDeductionReconciliation.ts` |
| Serialized fresh durable-state gate | `src/utils/autoDeductionStockGate.ts` |
| Hydration / resume entry | `src/hooks/useExactAutoDeductionReconciliation.ts`, `src/App.tsx` |
| Legacy day settlement & projection | `src/utils/dateCalculations.ts` |

---

## Purpose and scope

**Purpose:** Fire dose times at exact wall-clock moments even when the app process is not running, then apply each fired occurrence to application stock at most once when JavaScript can run.

**In scope today:**

- One-shot native exact alarms and durable native occurrence events
- JS reconciliation into medications, consumption markers, and logs
- Coordination with existing day-level settlement (`syncAutoDailyDeductions`)
- Multi-dose and legacy single-dose occurrence identity
- Crash-oriented durability for JS commits and native acknowledgement retries

**Non-goals of this document / this subsystem boundary:**

- Redesigning notification channels, sounds, or reminder UI
- Replacing AlarmManager with WorkManager/polling/foreground services
- Claiming that every product-level Take × Restore × exact-auto interaction matrix is exhaustively closed as a dedicated product surface (see *Take / Restore compatibility* below)

---

## Architecture overview

```text
Schedule (JS)
    → Native exact alarm
    → Receiver persists FIRED (no stock change)
    → App start / resume after hydration
    → Mutation gate loads fresh durable JS state
    → Reconcile FIRED events
    → Apply or no-op (idempotent)
    → Persist medications + logs
    → Mark native RECONCILED
```

Native owns **timing and durable fire records**.  
JavaScript owns **business stock, markers, logs, and acknowledgement**.

---

## Source of truth

| Question | Answer in current code |
|----------|------------------------|
| Did this occurrence fire at wall time while the app might be dead? | Native event store (SharedPreferences), status until successfully marked reconciled |
| What is the app’s committed inventory? | `Medication.currentPills` (+ related history fields) in localStorage (`android_med_tracker_items_v2`) |
| What does the UI show as “effective” remaining? | `effectiveCurrentPills(...)` — a **projection** from committed state + remaining due slots, **not** a second durable ledger |
| What prevents applying the same dose twice? | Occurrence markers, legacy day horizon, deterministic exact-auto log ids, native insert-if-absent, serialized gate |

**Native does not** write `currentPills`, does not write JS localStorage, and does not run settlement math.  
**A FIRED native row is not a stock mutation.** Stock changes only in JS reconciliation (or other JS paths such as legacy sync / manual take).

---

## Occurrence identity

Every exact auto occurrence is identified by:

```text
medicationId + doseId + calendarDate
```

Used consistently for:

- Native storage key and PendingIntent **data URI** (plus fixed action; request code is only a namespace, not the uniqueness mechanism)
- JS occurrence keys and deterministic log ids

**Not** used as identity: array index, time string alone, `dailyDose`, “first dose”, “next dose”, or schedule position.

**Legacy / single-dose:** empty or missing `doseId` is normalized to `LEGACY_DOSE_ID` (`__legacy_daily__`) in JS reconciliation.

---

## Native scheduling and fire path

1. After hydration (and when exact-alarm capability allows), JS requests `scheduleOccurrence` with medication, dose, calendar date, time, and **amount**.
2. Native persists schedule metadata and installs the one-shot alarm inside a serialized, process-wide scheduling critical section (durable metadata write, then AlarmManager install, with ownership-safe / conditional metadata rollback if installation fails). This is not an ACID transaction spanning SharedPreferences and AlarmManager; it is a process-local serialization of those steps.
3. PendingIntent identity matches schedule and cancel: action `AUTO_DEDUCTION` + occurrence URI from the identity triple.
4. On fire, `AutoDeductionReceiver` calls `insertFiredIfAbsent` — durable **FIRED** row; **no** stock update; may schedule the next one-shot occurrence.
5. On boot / quick boot, system restore promotes past schedules (serialized fire + ownership-safe metadata removal) and reinstalls future alarms from schedule preferences.

Exact fire does **not** require WebView or a running JS bridge.

---

## Native event lifecycle: FIRED and RECONCILED

| Status | Precise meaning |
|--------|-----------------|
| **FIRED** | The occurrence is durably recorded in the native event store and has **not yet been successfully acknowledged** as `RECONCILED` via `markReconciled`. |
| **RECONCILED** | Native acknowledgement succeeded after JS reconciliation reached the required durable application-side outcome for that occurrence (apply or intentional no-op ack). |

**Important:** `FIRED` does **not** mean “JS has never processed this occurrence.”

Valid sequence:

1. JS reads FIRED and applies stock + markers + log  
2. JS persists durably  
3. `markReconciled` fails  

Native status remains **FIRED**, while JS already holds the applied markers. A later run must **acknowledge only**, not deduct again.

---

## JavaScript reconciliation

Entry: `useExactAutoDeductionReconciliation` when `hydrated && !isFirstRun` (and on resume tick).

Orchestration (`runAutoDeductionReconciliation`):

1. Enter `withAutoStockMutationGate`
2. Load **fresh** medications and logs from durable storage (not a pre-gate React snapshot)
3. `listFired` native events
4. `reconcileFiredEvents`: sort by `scheduledAtEpochMs`, then occurrence key
5. Per event: validate amount/identity; check idempotency; apply or skip; collect acknowledgements
6. On stock/log mutation: write durability envelope → persist meds → persist logs → mark native events → clear envelope (see durability)
7. Update React from the **committed** durable result

Outcomes include: `applied`, `already_applied`, `skipped_missing_med`, `skipped_disabled`, `skipped_invalid`. Missing medication and disabled auto-deduct acknowledge without stock change so FIRED queues do not grow forever on those cases.

---

## Exact-event historical settlement

When applying an exact event on calendar date **D** for a gated medication, earlier unsettled days may still need folding into `currentPills`.

**Rule:**

```text
Prior historical units =
  days strictly after lastSyncDate
  AND strictly before D
  (historicalRangeDueUnits(lastSync, D))

Then apply event.amount for the occurrence on D.
```

Equivalently: settle eligible history with **dates &lt; D**, then apply exact occurrence **D**.  
**Not:** settle history with **dates ≤ D**, then apply **D** again.

That exclusion of **D** prevents double-charging the same occurrence when `pastDueUnits` measured through “today” would already include day D.

Days **before** D that are still due continue to participate. Same-day **sibling** doses on D are **not** auto-settled by this prior window.

After folding prior units, `lastSyncDate` may advance only to the end of that prior window (day before D), not automatically to “today.”

---

## Multi-dose behavior and sibling isolation

- Each slot has its own `doseId` and scheduled amount.
- Reconciliation uses **`event.amount`**, never medication-level `dailyDose` as a substitute for that occurrence.
- On one medication and one `calendarDate`, doses A, B, C are **independent** occurrences:
  - Applying A does not mark B applied
  - Does not subtract B’s amount
  - Does not share B’s deterministic log id

---

## Legacy day settlement compatibility

`syncAutoDailyDeductions` remains the bulk / day-horizon path. Exact reconciliation shares stock and markers with it.

**Native-first:** exact apply records consumption (or equivalent terminal markers) → later legacy `historicalDayDueUnits` skips consumed/skipped slots → no second charge of that occurrence.

**Legacy-first:** day settlement advances `lastSyncDate` and reduces `currentPills` → later exact event with `calendarDate < today` and `calendarDate <= lastSync` is treated as already reflected → acknowledge only.

`lastSyncDate` is a **day-settlement horizon**, not a per-dose event ledger. Per-dose truth remains consumption / skip history (and legacy `lastConsumedDate` where applicable).

Hydration-time legacy sync and exact reconciliation both use the **same** stock mutation gate with fresh durable loads.

---

## Take / Restore compatibility (implemented vs further product work)

**Implemented today (compatibility / idempotency):**

Exact reconciliation uses the same occurrence-level consumption and skip history helpers used elsewhere in the app. A dose already taken or skipped for that `doseId` + date is `already_applied` for exact auto. Applying exact auto records consumption markers so a later manual take path that checks the same history can see the occurrence as already consumed. Restore and skip history remain part of the shared occurrence model.

**Not claimed here:** a complete, product-level matrix of every race between Take, Restore, exact native fire, and legacy sync as a dedicated redesigned workflow. Further product tightening of that matrix is future work; it is **not** accurate to say Take/Restore “do not integrate” with exact auto today.

---

## Idempotency (separate layers)

| Layer | Role |
|-------|------|
| **Occurrence markers** | `doseConsumption` / history, `doseSkippedHistory`, legacy `lastConsumedDate` — terminal for that dose+date |
| **Legacy horizon** | `lastSyncDate` — past calendar days already folded by day settlement |
| **Deterministic exact-auto log** | `exact-auto:{medicationId}:{doseId}:{calendarDate}` — retries do not create a second logical exact-auto log row |
| **Native insert-if-absent** | One durable native row per occurrence key |
| **Serialized gate** | One mutation job at a time, each on fresh durable state |

These are complementary checks, not a single undifferentiated “marker.”

---

## Durable mutation gate

`withAutoStockMutationGate` is a **serialized mutation boundary on fresh durable state**, not a queue of stale React snapshots.

For each job:

1. Enter the gate (wait for prior jobs)
2. **Load** latest meds/logs from localStorage keys used by the app
3. Compute the mutation from that state
4. Persist the resulting durable state (caller / orchestrator)
5. Let React follow the committed result

This prevents concurrent “both started from currentPills = 10” overwrites when two auto paths interleave.

---

## Durability envelope and crash recovery

Envelope key: `android_med_tracker_exact_auto_envelope_v1`  
Holds intended medications, logs, and acknowledgement list after a mutating reconcile.

**Logical order:**

```text
write envelope
  → write medications
  → write logs
  → mark native event(s) RECONCILED
  → clear envelope
```

If meds/logs cannot be written, native marks are not performed for that mutating attempt; envelope remains for recovery.

**After successful JS meds+logs commit:** the envelope is cleared even if some native marks fail. Remaining **FIRED** rows stay retryable. Application-side idempotency (markers + deterministic logs) prevents a second stock mutation or duplicate exact-auto log when marks are retried.

---

## Partial native acknowledgement

Example: events A and B both applied in one JS commit; `markReconciled(A)` succeeds; `markReconciled(B)` fails.

- Stock and logs for both occurrences are already durable
- A is RECONCILED; B remains FIRED
- Next reconciliation lists B, sees markers / log → **already_applied** → mark B only
- No second deduction; no second exact-auto log id

Clearing the JS envelope after durable application does **not** imply every native acknowledgement succeeded.

---

## Hydration, resume, reboot

- **Hydration:** `hydrated` is set only after the initialization work required by the app’s hydration flow completes, including permission initialization and `initNativeBridge()`, so hydration-gated effects (persistence, legacy sync, exact reconcile, native schedule hook) do not run against an incomplete native surface. **Exact-alarm capability is separate:** it controls whether exact-alarm scheduling flows may install or restore alarms, and is **not** a general prerequisite for completing hydration itself. The app can finish hydration even when exact-alarm capability is unavailable; scheduling paths handle that capability according to the implementation.
- **First run** (`isFirstRun`): seed inventory skips auto deduction / reconcile effects.
- **Resume:** resume tick can re-enter reconciliation for remaining FIRED events.
- **Reboot:** native restores future schedule alarms; FIRED rows remain until JS acknowledges.
- **Empty medication UI text is not a hydration marker**; it can appear whenever the list is empty while the bridge is still pending.

---

## Committed stock vs effective balance

- **`currentPills`:** committed, persisted application snapshot.
- **`effectiveCurrentPills`:** derived projection (snapshot minus still-due auto amounts given markers and schedule). It is **not** an independent durable stock source of truth.

After an exact occurrence is applied, markers remove that slot from due helpers so projection does not subtract the same occurrence again on top of the snapshot.

---

## Recovery matrix

| Scenario | Expected behavior |
|----------|-------------------|
| Native fires, app closed | FIRED stored natively; no JS stock change yet |
| App opens later | JS reconciles FIRED after hydration |
| JS persistence fails | No native mark for mutating path; retry from FIRED / envelope |
| Native ack fails after JS commit | Stays FIRED; retry is acknowledge-only if markers exist |
| Duplicate FIRED delivery | No second stock deduction; one exact-auto log id |
| Same med, different doseId | Independent occurrences |
| Same doseId, different calendarDate | Independent occurrences |
| Legacy settlement already covered the day | Exact event does not deduct again |
| Native-first occurrence | Exact event applies once; later legacy skips it |
| Medication deleted | Acknowledge without stock mutation |
| Auto-deduct disabled | Acknowledge without stock mutation |

---

## Operational invariants

1. Native exact fire does not mutate application stock and does not require WebView.
2. Occurrence identity is always `medicationId + doseId + calendarDate`.
3. Multi-dose exact apply uses `event.amount`.
4. Historical settlement for an exact event on day D only includes eligible days **strictly before D**, then applies D’s `event.amount`.
5. Sibling doses on the same date remain isolated.
6. Stock mutations for auto paths load **fresh durable state** inside the mutation gate.
7. Mutating reconcile persists JS state before relying on successful native acknowledgement; failed marks remain safely retryable.
8. Duplicate reconciliation is idempotent for stock and exact-auto logs.
9. `effectiveCurrentPills` is a projection over committed state, not a second ledger.
10. Android device/emulator field verification of the full path is tracked explicitly (see below)—not implied by unit coverage alone.

---

## Validation status

**Repository:** Architecture and key invariants are covered by repository unit tests and static review of the implementation. **This documentation change does not execute those tests and does not alter production code.**

**Android runtime / emulator / device:** End-to-end validation of AlarmManager fire → FIRED → cold start → single stock apply → RECONCILED under real device conditions remains **unverified in the environment used for this documentation work**. Do not treat the pipeline as field-proven on hardware until that validation is performed and recorded separately.

---

## Phase 2 native platform notes (closure)

Native owns timing, AlarmManager install/cancel, boot/permission restore, and durable FIRED (plus pending-fire recovery namespace). JavaScript owns stock mutation, reconciliation, and RECONCILED acknowledgement (Phase 3) as specified above.

### Exact-alarm permission lifecycle

- Schedule paths require `canScheduleExactAlarms()` (API 31+).
- Manifest registers `SCHEDULE_EXACT_ALARM` and `RECEIVE_BOOT_COMPLETED`.
- **Receiver separation (security):**
  - `AutoDeductionReceiver` — `ACTION_AUTO_DEDUCTION` only, `android:exported="false"` (explicit AlarmManager PendingIntent).
  - `AutoDeductionSystemReceiver` — `BOOT_COMPLETED` / `QUICKBOOT_POWERON` / `TIMEZONE_CHANGED` / `ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED`, `android:exported="true"` (system broadcasts on API 31+). Invokes `AutoDeductionLifecycle.promoteAndRestore`.
- On `TIMEZONE_CHANGED`, future alarms are rebuilt from durable schedule metadata using the current default timezone (`calendarDate` + `timeHhmm`); historical FIRED/RECONCILED events are not altered and occurrence identity is unchanged.
- JS desired-state reconciliation lists native schedule metadata via `listScheduledOccurrences` and cancels keys not in the desired set (avoids resurrecting stale schedules after process restart). System restore is **not** invoked on every JS schedule pass.

### FIRED durability and recovery

| Path | Behavior |
|------|----------|
| Primary FIRED commit success | Event in main ledger; pending cleared |
| Primary fail + retry success | Same |
| Primary + retry fail, pending commit success | Pending in separate SharedPreferences file; promoted on boot / listEvents |
| Primary + retry + pending all fail | Schedule metadata for that occurrence is **kept** on past restore (last recovery source) |
| Duplicate delivery | `ALREADY_EXISTS`; no second event |

### Fire-vs-cancel linearization

Native fire and cancellation are serialized on the same process-wide `SCHEDULE_LOCK` so that **exactly one** operation linearizes first:

- If **fire** linearizes first (`fireOccurrenceIfNotCancelled`): the effective-cancellation check and durable FIRED (or pending-fire) transition run as one critical section. A later cancel cannot retroactively erase that fire. Pending-fire recovery after process death remains valid for fires that already linearized.
- If **cancellation** linearizes first (`cancelOccurrence` tombstone under the same lock): a subsequent or in-flight stale alarm delivery observes effective cancellation inside the same critical section and must **not** create FIRED, pending FIRED, or recurrence.

A separate cancel check *outside* the FIRED write is not sufficient: that would leave a TOCTOU window between “not cancelled” and durable fire persistence.

Lock order is always `SCHEDULE_LOCK` then nested `EventStore.LOCK` (never the reverse).

### Receiver / recovery next-occurrence truth table

| Fire linearization result | Schedule next |
|---------------------------|---------------|
| CREATED | Yes — create D+1 if absent |
| ALREADY_EXISTS | Yes — ensure D+1 if absent; **never overwrite** existing D+1 |
| FAILED + pending-fire recorded | Yes — same create-if-absent rule |
| CANCELLED | No |
| FAILED without pending | No |

Live fire recurrence uses `scheduleNextOccurrenceIfAbsent`. Under one continuous `SCHEDULE_LOCK` critical section:

- If durable schedule metadata for D+1 already exists, the delivery's payload (`timeHhmm` / `amount`) is **not** applied. A duplicate/stale D alarm must not replace a correct D+1 that was scheduled with newer parameters.
- If D+1 metadata is absent but the successor is **effectively cancelled** (`isOccurrenceCancelledKey`), the helper returns success without creating D+1. Calling the normal schedule path would clear the cancellation tombstone and resurrect a previously cancelled occurrence from a stale/duplicate D delivery — that must not happen.
- If D+1 is absent and not cancelled, it is installed via the normal schedule transaction.

The fire event itself remains insert-if-absent (`ALREADY_EXISTS`); create-if-absent recurrence respects both existing successor metadata and effective occurrence cancellation.

### Past-schedule recovery and recurrence

A past schedule entry still present at restore (device was unavailable at fire time, or primary FIRED commit failed while schedule metadata remained) is recovered via `fireOccurrenceIfNotCancelled`. That recovery **counts as a consumed occurrence for recurrence purposes**: the occurrence is durably represented as FIRED (or pending-fire, later promoted).

Restore works from a **snapshot** (`prefKey`, payload, `observedVersion`). After a durable fire outcome:

1. Under `SCHEDULE_LOCK`, confirm the snapshot still **owns** the past schedule row (`scheduleVersion == observedVersion`). If the row was replaced or removed, the snapshot is **stale** — do **not** schedule or overwrite D+1 using obsolete `timeHhmm`/`amount`.
2. If ownership holds and D+1 metadata is absent, install D+1 via the normal schedule transaction (same dose identity and snapshot amount/time). If D+1 already exists, leave it untouched.
3. Only when the successor is established, resolve past metadata with ownership-safe `removeScheduleMetadataIfVersion(observedVersion)`.

If successor scheduling fails for a non-stale reason, past metadata is **kept** so a later restore can retry. Stale snapshots neither overwrite D+1 nor delete a newer D. Cancellation still does not schedule a successor. Both normal past recovery and timezone-recomputed-past recovery use this rule. Repeated restore is idempotent: `ALREADY_EXISTS` + existing D+1 does not create duplicate logical occurrences.

### Multi-day missed-dose catch-up (Issue #243)

**Policy:** every missed exact-dose occurrence is reconstructed as a durable native `FIRED` event. There is **no catch-up horizon**.

Given a persisted schedule snapshot on calendar date `D` for `(medicationId, doseId)` with `timeHhmm` / `amount` / `recurrenceGeneration`, when restore runs at local time `T` on date `R`:

1. Walk calendar dates from `D` forward using `nextCalendarDate` / `computeEpochMs` (device default timezone).
2. For each date whose scheduled epoch is already due (`epoch <= now`, including the scheduled minute):
   - Recover via `recoverMissedOccurrence` under `SCHEDULE_LOCK`: cancellation check, active recurrence-generation authorization, then `insertFiredIfAbsent` (idempotent).
   - Do **not** require live schedule metadata / `scheduleVersion` ownership for that historical date (unlike a real AlarmManager delivery).
3. Stop historical catch-up at the first date whose dose time is still in the future; install **only** that occurrence as the live AlarmManager schedule.
4. Multi-dose slots are independent: each `doseId` walks its own chain with its own amount/time.
5. Native still does **not** mutate `currentPills`, localStorage, or WebView state — recovered rows are FIRED only; JS reconciliation applies stock later.
6. If recurrence generation was invalidated mid-walk, catch-up stops and does not schedule a future continuation for the stale generation.
7. Crash mid-walk is retry-safe: already-FIRED dates become `ALREADY_EXISTS`; remaining due dates continue on the next restore.
8. Installing the first future successor is atomic with generation re-validation under the same `SCHEDULE_LOCK`: either the successor is stamped with the recovery generation while it is still active, or invalidation wins and no successor is installed. Recovery never stamps a newer generation onto a stale recovery chain.

### Restore / cancel

- `scheduleOccurrenceLocked` holds `SCHEDULE_LOCK` for ownership check + metadata + AlarmManager install (restore uses `requiredVersion`). The authoritative `scheduleVersion` (`{millis}-{seq}-{uuid}`) is allocated **inside** this lock so its ordering token reflects serialized operation order, not the wall-clock time at which a thread waited for the lock.
- The `seq` component is a **durable monotonic counter** in a dedicated SharedPreferences namespace (`PREFS_ORDERING` / `lastAllocatedSequence`). Allocation is read → increment → `commit` under `SCHEDULE_LOCK`. This is not an in-memory `AtomicLong`: after process death the counter resumes from the last persisted value, so a new operation always receives a strictly newer seq than any previously durable token. Skipped sequence numbers after a crash are acceptable; reusing an older durable seq is not. If the counter commit fails, the schedule/cancel operation fails (no volatile fallback).
- Cancel writes a durable cancellation tombstone (occurrence identity + the same style of ordering token) before AlarmManager.cancel and schedule-metadata removal — also under `SCHEDULE_LOCK`. Same-millisecond schedule vs cancel and post-restart ordering are both distinguished by the durable sequence.
- **Effective cancellation** is evaluated from durable state only (`isOccurrenceCancelled`):
  - tombstone present and no schedule metadata → cancelled
  - both present → compare ordering tokens by (millis, seq); a strictly newer schedule supersedes the tombstone (active); a strictly newer cancel remains cancelled
  - no tombstone → not cancelled
- Cancelled occurrences are blocked in **both** lifecycle restore and `AutoDeductionReceiver` fire handling via the same serialized fire transition: no synthetic FIRED, no pending FIRED, no next recurrence when cancel linearizes first. A stale alarm that races with cancel cannot win the fire linearization after the tombstone is durable under `SCHEDULE_LOCK`.
- A later legitimate `scheduleOccurrence` writes new schedule metadata (lock-ordered `scheduleVersion`) then best-effort clears the tombstone. If tombstone removal fails, version ordering still treats the newer schedule as active so reboot/restore and fire delivery do not suppress it.
- Past schedule recovery treats a durable fire (FIRED or pending-fire) as a consumed occurrence for recurrence: the successor is scheduled before ownership-safe removal of the past metadata. Metadata is removed only when cancel linearized first, or when durable fire recovery succeeded **and** successor scheduling succeeded — and **only if** the current `scheduleVersion` still matches the restore snapshot’s `observedVersion`. A newer legitimate reschedule that replaced the snapshot row must not be deleted. If successor scheduling fails, past metadata is kept for retry. Missing metadata is treated as already gone (no recreate).

### Platform limitations

- Force-stop cancels alarms on stock Android; recovery is boot restore and/or JS reschedule after next launch.
- OEM aggressive battery managers may delay exact alarms; architecture remains reconstructible from durable schedule metadata + FIRED/pending stores.
- Pending and main FIRED both use SharedPreferences (separate files); they are separate durable namespaces, not a different storage technology.
- Full Android emulator/device matrix (Doze, OEM force-stop, permission toggle) is environment-dependent; see Validation status above.

---

## Future work (narrow)

Further product-level completion of the Take / Restore × exact-native-auto interaction matrix beyond the occurrence-level compatibility already shared via consumption/skip markers. Notification and scheduling UX remain outside this subsystem’s stock path.

