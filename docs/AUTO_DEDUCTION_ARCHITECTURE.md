# Automatic Dose Deduction — Architecture & Contract

## 1. Scope

This document is **Phase 1 only**: architecture discovery, current-state verification, and contract design for **exact-time automatic dose deduction on Android**.

### In scope

- Thorough inspection of the existing repository behavior.
- Documentation of current balance, Take, Restore, multi-dose identity, notification scheduling, and native lifecycle.
- Design of a target architecture for exact-time auto-deduction that is independent of notification delivery.
- Definition of durable event contract, idempotency, reconciliation, source-of-truth, failure recovery, storage options, and future implementation phases.

### Out of scope (explicitly forbidden in Phase 1)

- Any modification of production source code, tests, Android native code, or configuration.
- Addition of AlarmManager, BroadcastReceiver, Service, Worker, SQLite, SharedPreferences code, or changes to `currentPills` / `effectiveCurrentPills` / `syncAutoDailyDeductions` / Take / Restore / notification / scheduling behavior.
- Execution of any `npm` / `npx` commands.
- Implementation of any Phase 2+ work.
- Commits, PRs, or merges.

The single deliverable of this phase is this file:

```text
docs/AUTO_DEDUCTION_ARCHITECTURE.md
```

Every claim about **CURRENT BEHAVIOR** is backed by repository symbols and paths. Claims that cannot be verified are marked **NOT VERIFIED FROM REPOSITORY**.

---

## 2. Repository Findings

### High-level structure (verified)

| Area | Location | Notes |
|------|----------|-------|
| Frontend (React + Vite + Capacitor) | `src/` | Main app: `App.tsx`, components, hooks, utils, types, native bridge |
| Types / medication model | `src/types.ts` | `Medication`, `MedicationDose`, `ConsumptionLog` |
| Balance / auto-settlement | `src/utils/dateCalculations.ts` | `effectiveCurrentPills`, `syncAutoDailyDeductions`, `todayDueUnits`, `computeDueDoseBreakdown` |
| Take / Restore | `src/utils/medActions.ts` | `consumeDose`, `restoreDose`, `settleAndAdjust` |
| Dose schedule helpers | `src/utils/doseSchedule.ts` | Schedule validation, identity helpers, card toggle resolution |
| Notifications | `src/utils/notifications.ts` | Channels, schedule helpers, exact-alarm permission |
| Dose reminder scheduler | `src/hooks/useDoseReminderScheduler.ts` | Per `(medId, doseId)` scheduling, exact-alarm gate |
| Critical alarms | `src/hooks/useCriticalAlarmScheduler.ts` | Separate critical-stock path |
| Native bridge | `src/native.ts` | Channels, listeners, appState, exact-alarm re-check |
| Android customizations | `native-android/` | `MainActivity.java`, `TimedNotificationPublisher.java`, `AppForegroundState.java` |
| Persistence | `src/utils/storage.ts` + localStorage keys in `App.tsx` | Keys such as `android_med_tracker_items_v2` |
| Tests | `Tests/` | Extensive unit/integration coverage of balance, Take, Restore, multi-dose, notifications |

### What exists today for “auto deduction”

**CURRENT BEHAVIOR:** Auto-deduction is **not** driven by exact per-dose Android alarms. It is a combination of:

1. **Projection** (`effectiveCurrentPills`) that subtracts time-elapsed due units (including same-day elapsed slots) from the stored snapshot without mutating storage.
2. **Settlement** (`syncAutoDailyDeductions`) that runs once after hydration (and on certain mutations) and writes past-day due units into `currentPills` + `lastSyncDate`, producing `auto_daily` logs.

Same-day elapsed doses remain **projection-only** until a later settlement opportunity (next app open / mutation path). There is **no** native exact-time stock deduction path today.

### What does **not** exist today (verified by absence)

- No native durable auto-deduction event ledger.
- No `BroadcastReceiver` dedicated to stock deduction (only notification delivery via Capacitor’s `TimedNotificationPublisher`).
- No explicit app-owned `BOOT_COMPLETED` receiver for dose auto-deduction (notification boot behavior is delegated to Capacitor Local Notifications plugin; app re-arms on launch/resume — see tests and comments in `src/hooks/useCriticalAlarmScheduler.ts` and `Tests/App.test.tsx`).
- No WorkManager / foreground service used for dose stock deduction.
- No SQLite usage for medication stock or dose events in the inspected sources.

---

## 3. Current Architecture

### Application lifecycle (CURRENT)

1. **Cold start / mount** (`src/App.tsx`):
   - Deterministic first render from defaults.
   - Load medications, logs, settings from localStorage (`loadJson` / `loadString`).
   - Run `migrateSchema`.
   - Parallel permission + `initNativeBridge()`; only then set `hydrated = true`.
2. **Post-hydration one-shot settlement** (`src/App.tsx`, effect gated on `hydrated` + `deductedRef`):
   - If `globalAutoDeductEnabled` and not first-run → call `syncAutoDailyDeductions(medications, today)`.
   - Persist updated meds + new `auto_daily` logs; optional toast.
3. **Ongoing**:
   - `useDoseReminderScheduler` schedules **notifications** only (gated on `notificationsEnabled` and `exactAlarmEnabled === true`).
   - `useCriticalAlarmScheduler` handles critical-stock one-shot alarms.
   - UI reads **effective** balance via `effectiveCurrentPills` (and related helpers), not raw `currentPills`.
4. **Resume**:
   - `registerAppResumeHandler` / lifecycle ticks re-check exact-alarm permission and re-arm reminder scheduling / consumption suppression. Stock settlement is **not** re-run every resume beyond the one-shot hydration path (settlement also occurs inside mutation helpers when needed).

### Persistence (CURRENT)

- Primary store: **browser/WebView localStorage** via `src/utils/storage.ts`.
- Medication list key: `android_med_tracker_items_v2`.
- Global auto-deduct flag: `android_med_tracker_auto_deduct_v1`.
- Logs: `android_med_tracker_logs_v2`.
- No native durable store for stock events today.

### Native layer (CURRENT)

- Capacitor 6 + `@capacitor/local-notifications`.
- Customized `TimedNotificationPublisher` rewrites dose-reminder channel at delivery time based on process-local `AppForegroundState` (`native-android/`).
- `MainActivity` sets foreground flag on resume/pause.
- Exact-alarm permission is queried from JS (`getExactAlarmPermission` in `src/utils/notifications.ts`) and gates **reminder scheduling**, not stock deduction.

---

## 4. Current Balance Model

### A. Stored balance — `currentPills`

**File:** `src/types.ts` (`Medication.currentPills`), mutated by settlement/Take/Restore/refill paths in `src/utils/dateCalculations.ts` and `src/utils/medActions.ts`.

**Meaning (CURRENT):** The last **settled snapshot** of remaining stock as of `lastSyncDate`. It does **not** by itself include same-day elapsed auto-due amounts until settlement runs.

### B. Displayed balance — `effectiveCurrentPills`

**File:** `src/utils/dateCalculations.ts` → `effectiveCurrentPills()`.

**Meaning (CURRENT):** Dynamic projection used for **all UI display** of remaining stock:

```text
if autoDeductEnabled === false → currentPills
else if dailyScheduleAmount <= 0 → currentPills
else → max(0, currentPills - fullDueUnits)
```

where `fullDueUnits` comes from `computeDueDoseBreakdown` (past due units + today’s time-elapsed, non-consumed, non-skipped units).

Comments in the same file state this is the **single source of truth** for “how many pills the user actually has right now” for display.

### C. Auto settlement — `syncAutoDailyDeductions`

**File:** `src/utils/dateCalculations.ts` → `syncAutoDailyDeductions()`.

**When it mutates persistent stock (CURRENT):**

- Called from `App.tsx` once after hydration (if global auto-deduct on).
- Also conceptually aligned with mutation settlement helpers (`settleDoseChange`, `settleAutoDeductToggle`, consume/restore paths that settle past units).

**What it settles:**

- For **gated / multi-dose** meds: **only `pastDueUnits`** (fully elapsed prior calendar days). Today’s slots stay dynamic.
- For **legacy non-gated**: `fullDueUnits` including today (calendar-day start semantics).

Produces `ConsumptionLog` entries with `type: 'auto_daily'`.

### D. Same-day elapsed dose (app open)

Example: schedule 08:00, current time 10:00, app open.

**CURRENT:**

- `todayDueUnits` includes the 08:00 slot amount if not consumed and not skipped (`src/utils/dateCalculations.ts` → `todayDueUnits`).
- `effectiveCurrentPills` subtracts that amount for display.
- `currentPills` is **unchanged** until a settlement path runs that includes that unit (typically a later day boundary via past settlement, or a mutation that settles).

### E. App closed then reopened same day

Example: closed at 08:00, reopened at 17:00.

**CURRENT:**

- On open → hydration → `syncAutoDailyDeductions` settles **past days only** (gated path).
- Same-day elapsed slots appear via projection in `effectiveCurrentPills`.
- No native event was recorded while the app was killed.

### F. Several days closed

**CURRENT:**

- On open, `syncAutoDailyDeductions` computes historical due units from `lastSyncDate` to today (multi-dose uses `historicalRangeDueUnits` / per-slot consume & skip history) and mutates `currentPills` + `lastSyncDate`, emitting `auto_daily` logs for the settled amount.

### Conceptual pipeline (CURRENT — verified)

```text
Stored snapshot (currentPills @ lastSyncDate)
        ↓
Projection of due units (past + same-day elapsed, respecting consume/skip)
        ↓
effectiveCurrentPills (display)
        ↓
On settlement opportunity → write past (or full, for legacy non-gated) into currentPills
```

Same-day is **projection-first**; past days are **settled** when the JS settlement path runs.

---

## 5. Current Dose Identity

### Medication identity

- `Medication.id` (string) — stable primary key.

### Scheduled dose identity (multi-dose)

- `MedicationDose.id` (string) — generated via `generateId('dose')` in `src/utils/doseSchedule.ts` when creating/editing schedule rows.
- Occurrence conceptual identity used throughout Take/Restore/history:

```text
medicationId + doseId + calendarDate (YYYY-MM-DD)
```

**Verified usages:**

- `isDoseConsumedOnDate(med, doseId, dateStr)` / `recordDoseConsumed` — `src/utils/dateCalculations.ts`
- `isDoseSkippedOnDate` / `recordDoseSkipped` / `clearDoseSkippedOnDate`
- `consumeDose(..., doseId?)` requires explicit `doseId` when `doseSchedule.length > 1` (`src/utils/medActions.ts`)
- Notification scheduling keys: `medId::doseId` (`doseScheduleKey` in `src/hooks/useDoseReminderScheduler.ts`)

### Legacy single-dose

- No `doseSchedule` (or empty): uses `dailyDose`, `lastConsumedDate`, optional `reminderTime`.
- Scheduler assigns synthetic `LEGACY_DOSE_ID` for reminder identity only (`useDoseReminderScheduler.ts`).

### Rule for target architecture

**MUST preserve** primary occurrence identity:

```text
medicationId + doseId + calendarDate
```

Do **not** use array index, time string alone, `dailyDose`, or “first/next dose” as primary identity.

If any legacy path still keys only by date + med (single-dose), migration in a later phase must map it to a stable doseId (or keep the legacy path isolated) without inventing history.

---

## 6. Current Take Flow

**Entry points (CURRENT):**

- Manual: UI → `handleConsumeDose` / card toggle paths in `src/App.tsx` → `consumeDose` (`src/utils/medActions.ts`).
- Alarm: notification received → DoseAlarmModal → take path with `source: 'alarm'`.

**`consumeDose` behavior (verified):**

1. Resolve target dose:
   - Multi with length > 1: **requires** valid `doseId`; unknown/missing → fail reason.
   - Multi with length === 1: omitted `doseId` resolves to that slot’s id.
   - Legacy: uses `dailyDose`; blocks if `lastConsumedDate === today`.
2. Reject if already consumed for that `doseId` + today (`already_consumed`).
3. Settle base stock:
   - Gated/multi: `currentPills - pastDueUnits` (do not double-count same-day projection).
   - Legacy non-gated: `effectiveCurrentPills`.
4. Deduct `min(targetAmount, settleBase)` from snapshot → new `currentPills`.
5. Record consume in `doseConsumption` / `doseConsumptionHistory`; clear skip for that dose+date.
6. Update `lastConsumedDate` when all slots consumed (or always for legacy).
7. Adjust `lastSyncDate` so remaining same-day slots stay projectable when multi and not fully consumed.
8. Emit `ConsumptionLog` type `dose_taken` with optional `doseId`.

**Duplicate Take:** blocked by consume history / `lastConsumedDate`.

**Interaction with auto projection:** Take settles past and deducts the slot from the settled base so `effectiveCurrentPills` does not subtract the same units again for that occurrence.

---

## 7. Current Restore Flow

**Entry:** UI restore / card paths → `restoreDose` (`src/utils/medActions.ts`).

**Multi-dose (CURRENT):**

1. Resolve amount via `resolveRestoreDoseAmount` (requires valid identity).
2. Clear manual consume markers for that `doseId` + date from `doseConsumption` / history.
3. Determine whether the occurrence is **past-due** relative to now (prior day, or today after slot time via `isDoseTimeElapsedToday`).
4. If past-due → record **skip** in `doseSkippedHistory` so projection/settlement will not re-due that occurrence.
5. If the consume was **manual** → `settleAndAdjust` adds the amount back to `currentPills`.
6. If the effect was **auto-only** (projection) → do **not** inflate `currentPills`; skip marker undoes the projection for past-due; future same-day restore before slot time leaves skip unset so auto can still apply at time.

**Legacy:** settle-and-adjust amount back; clear `lastConsumedDate` if it was today.

**`doseSkippedHistory`:** authoritative “this occurrence should not auto-due again for that date” after restore of an elapsed occurrence.

Future exact-time auto **must coexist** with this history: reconciliation must treat skipped occurrences as already handled for auto deduction.

---

## 8. Current Notification Architecture

### Scheduler

`src/hooks/useDoseReminderScheduler.ts`:

- Builds slots from `doseSchedule` (or legacy single slot with `LEGACY_DOSE_ID`).
- Schedules via `scheduleDoseReminder` / LocalNotifications.
- Tracker key: `medId::doseId`.
- Gated on `notificationsEnabled` **and** `exactAlarmEnabled === true`.
- Cancels when permission missing, notifications off, dose consumed, med deleted, etc.
- Resume / lifecycle ticks re-arm channels and suppression.

### Delivery

- Capacitor schedules native alarms for notifications.
- `TimedNotificationPublisher` (customized) may rewrite channel to foreground (silent) vs background (system sound) using `AppForegroundState`.
- Foreground receipt opens DoseAlarmModal; does **not** auto-mutate stock.

### Exact-alarm permission

- Queried in JS; false → **no** dose reminder scheduling (inexact unacceptable for meds).
- Settings deep-link available via `openExactAlarmSettings`.

### Independence requirement for target design

**CURRENT** notification path must remain independent of stock deduction:

```text
Configured dose occurrence
   ├──→ Notification alarm (user-facing reminder)
   └──→ Auto-deduction alarm (stock event)   ← NEW, separate
```

**Why:** Notification may be dismissed, denied, delayed by OEM, or never delivered; stock correctness cannot depend on UI notification delivery. Conversely, auto-deduction must not require showing a notification.

---

## 9. Target Architecture

### Preferred direction (evaluated against repo)

```text
User-configured dose (medicationId + doseId + local time + amount)
        ↓
Exact Android alarm (AlarmManager exact / exact-and-allow-while-idle as appropriate)
        ↓
Native BroadcastReceiver (lightweight)
        ↓
Durable native auto-deduction event (idempotent ledger entry)
        ↓
JS reconciliation on start/resume (and optionally explicit bridge pull)
        ↓
Existing medication / log persistence (localStorage via current helpers)
```

### Why this fits the repository

- Existing exact-alarm permission and scheduling culture already exist for reminders; reusing the permission model is natural.
- Stock mutation today is entirely JS + localStorage; keeping final stock mutation in JS preserves `consumeDose` / `restoreDose` / `syncAutoDailyDeductions` semantics and tests.
- Native side only needs a durable “this occurrence fired” fact, not business rules.
- Avoids permanent process, polling, and notification coupling.

### Alternatives considered

| Approach | Verdict |
|----------|---------|
| Deduct inside notification receiver | Rejected — couples stock to delivery; breaks when notifications disabled |
| JS timers / setInterval | Rejected — dead when process killed |
| WorkManager periodic | Rejected for exact wall-clock dose times |
| Foreground service always on | Rejected — battery / policy |
| Pure projection forever without settlement | Insufficient for durable history and multi-day offline |

**Recommendation:** Proceed with exact AlarmManager + durable native event + JS reconciliation, independent of notification alarms.

---

## 10. Auto-Deduction Event Contract

### Conceptual durable event (minimum fields)

| Field | Purpose | Creator | Reader | Mutable? |
|-------|---------|---------|--------|----------|
| `eventId` | Stable unique id for the ledger row | Native on fire (or schedule-time pre-create) | Native + JS | Immutable after create |
| `medicationId` | Med identity | Native (from schedule payload) | JS reconciliation | Immutable |
| `doseId` | Slot identity (`LEGACY_DOSE_ID` or real) | Native | JS | Immutable |
| `calendarDate` | Local YYYY-MM-DD of the occurrence | Native at fire (or schedule) | JS | Immutable |
| `scheduledAtEpochMs` | Intended local wall time | Native | JS / debug | Immutable |
| `amount` | Units to deduct for this slot | Native (from schedule payload) | JS | Immutable |
| `status` | Lifecycle | Native + JS | Both | Controlled transitions only |
| `createdAtEpochMs` | Audit | Native | Debug | Immutable |
| `reconciledAtEpochMs` | Audit | JS after successful persist | Both | Set once |

### Status state machine (simplest reliable)

```text
FIRED  →  RECONCILED
```

Optional intermediate `READY_FOR_RECONCILIATION` if native write and JS read are split; not required if the durable row is written atomically as `FIRED` and JS only advances to `RECONCILED` after successful stock/log persistence.

**Idempotency:** uniqueness of `(medicationId, doseId, calendarDate)` in the ledger — at most one `FIRED`/`RECONCILED` row per occurrence.

### Who does what

- **Native receiver:** ensure ledger contains exactly one row for the key; set status `FIRED` if absent; never invent amounts not present in the scheduled payload.
- **JS reconciliation:** read unreconciled (`FIRED`) rows; apply business rules; on successful localStorage persist of meds/logs, mark `RECONCILED`.

---

## 11. Idempotency Contract

### Canonical key

```text
medicationId + doseId + calendarDate
```

### Guarantees

One automatic stock deduction per key, even under:

| Hazard | Where protected |
|--------|-----------------|
| Duplicate AlarmManager delivery | Native insert-if-absent on key before/within receiver |
| Duplicate BroadcastReceiver | Same native uniqueness constraint |
| Multiple app startups | JS skips if already consumed/skipped **or** native status already `RECONCILED` **or** stock/log already reflects the occurrence |
| Resume storms | Same reconciliation filters |
| Process death mid-reconcile | Native remains `FIRED` until JS confirms persist; JS re-applies only if med state does not already show consume/skip/settlement for that key |
| Device reboot | Ledger survives; future alarms rebuilt; old keys not re-fired |
| Take then Auto | Take records consume history → reconciliation no-ops stock change |
| Auto then Take | After reconcile, consume history or settled snapshot makes Take’s `already_consumed` / zero-effect path engage |
| Auto then Restore | Restore writes skip (if past-due) or undoes manual; reconciliation treats skip/consume as terminal for auto |
| Persistence failure after native fire | Event stays `FIRED`; retry safe because JS checks med state before mutating |

**Do not** rely solely on “check if log exists” without also checking consume/skip history and effective settlement state; the durable native key is the primary cross-process guard, and JS med fields are the primary business guard.

---

## 12. Source of Truth

### Q1 — That the scheduled dose occurrence “happened” (time reached)

**PROPOSED:** Native durable event ledger entry for the key (status `FIRED` or `RECONCILED`).

Notifications are **not** the source of truth.

### Q2 — Persistent medication stock

**CURRENT & PROPOSED:** `Medication.currentPills` (+ `lastSyncDate` and per-dose history fields) in localStorage via existing persistence. Native never becomes the stock authority.

### Q3 — User-visible effective balance

**CURRENT & PROPOSED:** `effectiveCurrentPills` (and related UI helpers). After reconciliation, projection and snapshot must agree so the same occurrence is not subtracted twice.

### Q4 — Between native fire and JS reconciliation

- Native ledger holds `FIRED`.
- Stock snapshot may still be pre-deduction; UI projection may still show the dose as due until reconcile **or** until design explicitly treats `FIRED` as already due for display (implementation choice — prefer reconcile-as-soon-as-possible on resume so window is short).
- No second native deduction.

### Q5 — Preventing `effectiveCurrentPills` double subtraction

After JS applies auto deduction for a key it must leave state such that `todayDueUnits` / historical due calculators **exclude** that occurrence, using the **same** mechanisms already used by manual Take and Restore:

- Prefer recording an auto consumption marker compatible with `isDoseConsumedOnDate` **or** advancing settlement (`currentPills` / `lastSyncDate`) so `fullDueUnits` no longer includes those units,
- and/or writing a dedicated auto-applied marker if extending the model.

**Critical interaction with existing projection:**

Today, same-day auto is projection-only. Exact-time reconciliation that mutates `currentPills` must also update history/sync fields so `computeDueDoseBreakdown` does not still count the slot in `todayDueUnits`.

Concrete strategy for Phase 3+ design:

1. On reconcile of a same-day multi dose: either treat like a silent Take for history purposes (without requiring user gesture) **or** settle units into snapshot and mark slot consumed for that date.
2. Ensure `isDoseConsumedOnDate` or skip history returns true for the key after success.
3. Only then mark native `RECONCILED`.

This closes the loop with `syncAutoDailyDeductions` so past settlement and exact-time settlement do not both apply the same units.

---

## 13. Reconciliation Contract

### Flow

```text
App starts or resumes (after hydrated)
  → Bridge: read native events with status FIRED
  → For each event (stable order):
       1. Verify medication still exists
       2. Verify doseId still in schedule (or legacy mapping)
       3. Verify calendarDate semantics
       4. If already RECONCILED in native → skip
       5. If isDoseConsumedOnDate / isDoseSkippedOnDate for key → mark RECONCILED only (no stock change)
       6. If global or per-med auto-deduct disabled → defined policy (see Settings)
       7. Apply stock/log mutation using same numerical rules as settlement/Take amount
       8. Persist JS state (meds + logs) successfully
       9. Only then mark native event RECONCILED
  → Continue
```

### Crash after JS persist but before native mark

Next run: JS sees consume/skip/settled state for key → step 5 → mark RECONCILED without second deduction.

### Crash after native FIRED but before JS persist

Next run: still FIRED; JS applies once.

### Ordering vs `syncAutoDailyDeductions`

**PROPOSED:** Run exact-time reconciliation **before** or carefully composed with the existing one-shot sync so the same units cannot be settled twice. Prefer: reconcile exact events first (marking history), then run daily sync which will see zero remaining due for those keys.

---

## 14. Take vs Auto Contract

| Scenario | Expected stock effect | Expected auto event / state |
|----------|----------------------:|-----------------------------|
| Take before scheduled time | `-amount` once (manual) | When time fires: native may FIRED; JS sees consumed → no second deduction; mark RECONCILED |
| Auto occurs first | `-amount` once (auto) | Later Take: `already_consumed` / zero effect |
| Duplicate auto event | `-amount` once | Native unique key + JS history |
| Take then Restore before scheduled time | restored (manual undo) | Future auto **may** execute at time (no skip if not past-due) — matches current Restore semantics |
| Auto then Restore | restored / skip as per current Restore | Same occurrence must not auto-deduct again (skip or history) |
| Auto then Restore then app restart | restored state survives in JS | Native RECONCILED or FIRED+JS skip path → no duplicate |
| Take + Auto race | `-amount` once | Idempotent key + history checks |

Determining fields: `doseConsumptionHistory` / `doseConsumption`, `doseSkippedHistory`, native ledger status, `currentPills` snapshot after successful mutation.

---

## 15. Restore vs Auto Contract

- **Future same-day restore (before slot time):** CURRENT leaves slot eligible; PROPOSED auto alarm may still fire and deduct once unless user disabled auto.
- **Past/elapsed restore:** CURRENT writes `doseSkippedHistory`; PROPOSED reconciliation must honor skip and not deduct.
- Auto then Restore must not leave ledger in a state that re-deducts after restart (mark RECONCILED when skip/consume present).

---

## 16. Multi-Dose Contract

Example:

```text
Medication M
08:00 dose A amount 1
14:00 dose B amount 2
22:00 dose C amount 3
```

**Rules:**

- Each occurrence key is independent: `(M, A, date)`, `(M, B, date)`, `(M, C, date)`.
- 08:00 deducts **1**, not `dailyDose`, not B/C amounts.
- Consuming A does not mark B consumed.
- Restoring B does not suppress C.
- Duplicate events for A do not affect B.
- Scheduling and reconciliation must use `MedicationDose.amount` for the specific `doseId`.

This matches CURRENT `todayDueUnits` / `consumeDose` identity rules.

---

## 17. Settings Contract

### Existing settings (CURRENT)

- **Global:** `globalAutoDeductEnabled` persisted under `android_med_tracker_auto_deduct_v1` (`src/App.tsx`).
- **Per medication:** `Medication.autoDeductEnabled` (default true when undefined) — `src/types.ts`; toggles settled via `settleAutoDeductToggle` in `dateCalculations.ts`.

### PROPOSED behavior

**Disable (global or per-med):**

- Cancel **future** exact auto-deduction alarms for affected occurrences.
- Do **not** delete historical native events blindly.
- Historical deductions and logs remain valid.
- Re-enable must **not** replay old FIRED events that were intentionally left unapplied while disabled (policy: on disable, either mark pending FIRED as cancelled/suppressed, or on reconcile no-op when auto disabled and mark RECONCILED without stock change — **choose one in Phase 2/6; prefer no-op + RECONCILED to avoid unbounded pending queue**).

**Enable:**

- Schedule only **eligible future** occurrences.
- Do not duplicate alarms (stable request codes / keys).
- Do not reconstruct native events for past dates solely to deduct again.

---

## 18. Reboot Contract

**CURRENT:** No app-owned `BOOT_COMPLETED` handler for dose auto-deduction in `native-android/`. Notification/critical paths rely on Capacitor plugin boot behavior and **app launch re-arm** (documented in tests/comments).

**PROPOSED:**

```text
Device reboot
  → Minimal BOOT_COMPLETED receiver (future phase)
  → Restore future eligible exact auto-deduction alarms from schedule + settings
  → Do not replay old dose occurrences
  → Preserve durable event ledger
```

Until implemented, alarms may be lost across reboot until app open re-schedules (same class of issue existing reminder code mitigates via resume/launch re-arm).

---

## 19. Time / Timezone / DST Contract

**Do not** schedule as `previousAlarm + 24h`.

**Prefer:** `calendarDate + configured local HH:mm` → compute next `Calendar` / `Zoned` trigger.

| Edge case | Intended behavior |
|-----------|-------------------|
| Midnight crossing | Occurrence belongs to the calendar date of the configured local time |
| Timezone change | Recompute future alarms from stored local time + new zone; do not shift past keys |
| DST skip (spring forward) | If local time does not exist, **IMPLEMENTATION-TIME VERIFICATION REQUIRED** (Android AlarmManager behavior); prefer next valid time same date or policy documented in Phase 2 |
| DST repeat (fall back) | Fire once for the occurrence key; do not double |
| Device clock change | Future alarms may be wrong until reschedule on resume; past keys remain idempotent |
| App opened after several days | Native ledger + JS historical settlement cover missed exact fires; schedule only future |
| Duplicate scheduled occurrence | Prevented by key uniqueness |

---

## 20. Failure & Recovery

| Failure | Expected recovery |
|---------|-------------------|
| WebView not running | Native event survives in durable ledger |
| App killed | Same |
| JS crashes during reconciliation | Retry; no duplicate deduction (history / status checks) |
| Native receiver runs twice | Idempotent insert-by-key |
| Device reboots | Future alarms rebuilt (Phase 6); ledger preserved |
| Local JS persistence fails | Event remains FIRED / retryable |
| Medication deleted before reconciliation | Mark RECONCILED or CANCELLED; no stock write |
| Dose schedule edited (doseId removed) | No stock write for orphan doseId; mark terminal |
| Auto deduction disabled after alarm scheduled | Cancel future; pending FIRED no-op+RECONCILED or explicit cancelled status |
| Duplicate alarm ID | Use stable request codes derived from occurrence key hash; cancel-before-schedule |

---

## 21. Native Storage Evaluation

| Option | Durability | Simplicity | Atomicity | JS access | Fit |
|--------|------------|------------|-----------|-----------|-----|
| **A. SharedPreferences** | Process-safe enough for small ledger | High | Per-key apply; not multi-row TX | Via Capacitor plugin / bridge | **Good** for low volume |
| **B. SQLite** | Strong | Higher complexity | Transactions | Bridge or Capacitor community plugins | Overkill initially |
| **C. Existing localStorage only** | Only while JS runs | N/A for killed process | N/A | Native cannot write | **Unsuitable** as sole ledger |

**Recommendation:** Start with **SharedPreferences** (or a single JSON blob file in app private storage) keyed by occurrence id, with a Capacitor plugin or thin bridge API: `listFiredEvents`, `markReconciled`, `scheduleOccurrence`, `cancelOccurrence`. Revisit SQLite only if event volume or querying requires it.

---

## 22. Resource Usage

```text
AlarmManager holds future alarms
  → device sleeps
  → exact alarm wakes briefly
  → BroadcastReceiver runs
  → write tiny ledger row
  → exit
```

No permanent foreground service, no JS polling, no periodic WorkManager for exact dose times.

Exact alarms are appropriate for **user-configured medication times** (time-critical, sparse, few per day). They require `SCHEDULE_EXACT_ALARM` / user grant on modern Android — already part of the app’s reminder model.

---

## 23. Data Integrity

Defenses (accidental corruption, not adversarial threat model):

- Reject unknown `medicationId` / `doseId` at reconcile.
- Reject non-positive or NaN `amount`.
- Ignore impossible calendar dates.
- Unique constraint on occurrence key.
- Treat corrupted ledger rows as non-actionable (log + mark terminal).
- Never decrease stock below zero beyond existing clamps.
- Schedule edits invalidate pending alarms for removed doseIds.

---

## 24. Backward Compatibility

| Existing data | Policy |
|---------------|--------|
| Medications | Unchanged; continue to work with projection + daily sync until exact path enabled |
| Logs | Retain; new auto events may add `doseId` on exact auto logs if introduced |
| `doseSkippedHistory` / consume history | Honor as-is |
| `currentPills` / `lastSyncDate` | Remain source of stock snapshot |
| `effectiveCurrentPills` | Remains display authority; must stay consistent after reconcile |
| Upgrade with multi-day gap | Existing `syncAutoDailyDeductions` still settles past days; exact path schedules **future only** |
| Reconstruct old historical doses as native events? | **No** — do not replay history into native ledger |
| Schedule future only? | **Yes** |

Feature flag / gradual enable recommended so exact auto can be tested without forcing all users immediately.

---

## 25. Risks

- **Double deduction** between projection, daily sync, exact reconcile, and Take — highest risk; requires strict history markers and ordering.
- localStorage vs native ledger divergence after partial failure.
- Race: Take and receiver near the same second.
- Restore semantics (future vs past) must remain aligned.
- Reboot without boot receiver → missed exact fires until app open (mitigated by daily sync for past days, gap for same-day until open).
- Timezone/DST edge cases.
- Schedule edits / doseId rotation orphaning alarms.
- Medication deletion mid-flight.
- Exact alarm permission denied → exact auto cannot run (must fall back cleanly to existing projection/sync).
- OEM battery restrictions killing alarms (same class as existing reminders).
- Identity mismatches for legacy meds without `doseSchedule`.

---

## 26. Unresolved Decisions

1. **Display during FIRED-but-unreconciled window:** Should UI treat FIRED as already deducted for `effectiveCurrentPills`, or wait for JS reconcile only?
2. **Disabled auto + pending FIRED events:** Cancel/suppress vs no-op reconcile — pick one policy.
3. **Legacy single-dose doseId:** Always use `LEGACY_DOSE_ID` in native keys, or generate a stable synthetic id per med?
4. **Whether exact auto writes `dose_taken` vs new log type** (e.g. keep `auto_daily` with `doseId`).
5. **Bridge API surface** (plugin name, methods, payload schema) — Phase 2 detail.
6. **DST non-existent local times** — confirm on target API levels during implementation.
7. **Whether to pre-create ledger rows at schedule time** vs only on fire.
8. **Interaction order** with existing one-shot `syncAutoDailyDeductions` on hydration (must be specified in Phase 3 tests).

---

## 27. Future Implementation Phases

### Phase 1 — Architecture / contract (THIS PHASE)

- Scope: this document only.
- Production files modified: **0**.
- Tests modified: **0**.

### Phase 2 — Native exact alarm + durable event ledger

- Scope: Android receiver, SharedPreferences (or file) ledger, schedule/cancel APIs, Capacitor bridge stubs, exact permission reuse.
- Likely files: `native-android/**`, new plugin sources, `src/native.ts` bridge methods, `scripts/prepare-android.mjs` if needed.
- Behavior changed: none user-visible stock yet (ledger only / dry-run flag).
- MUST NOT change: Take/Restore, `effectiveCurrentPills` math, reminder UX.
- Tests: native unit tests if available; bridge contract tests.
- Risks: permission, OEM alarm delivery.

### Phase 3 — JS reconciliation

- Scope: pull FIRED events; integrate with history; persist; mark RECONCILED; compose with `syncAutoDailyDeductions`.
- Likely files: `src/App.tsx`, `src/utils/dateCalculations.ts`, `src/utils/medActions.ts` (helpers only as needed), new util module.
- Behavior changed: exact-time stock updates when events present.
- MUST NOT change: notification delivery path.
- Tests: idempotency, crash-between-persist-and-mark, multi-day.

### Phase 4 — Take / Restore integration

- Scope: matrix enforcement; races; skip/consume precedence.
- Tests: full matrix from §§14–15.

### Phase 5 — Multi-dose + legacy verification

- Scope: amount isolation; `LEGACY_DOSE_ID`; schedule edit orphaning.
- Tests: `Tests/utils/dateCalculations.multidose.test.ts` style extensions.

### Phase 6 — Settings + reboot + lifecycle

- Scope: disable/enable, BOOT rescheduler, resume re-arm for auto alarms.
- MUST NOT change: unrelated critical-stock claim model.

### Phase 7 — Remove/refactor obsolete projection/settlement assumptions (optional)

- Scope: only after exact path is proven; reduce dual models carefully.
- High risk — separate go/no-go.

### Phase 8 — Automated tests + real Android runtime validation

- Scope: emulator/device matrices; exact alarm; reboot; DST if feasible; documentation parallel to `docs/ANDROID_NOTIFICATION_RUNTIME_VALIDATION.md`.

---

## 28. Phase 1 Acceptance Criteria

- [x] Repository structure was inspected.
- [x] Current medication state flow is documented.
- [x] `currentPills` behavior is verified (`src/types.ts`, settlement paths).
- [x] `effectiveCurrentPills` behavior is verified (`src/utils/dateCalculations.ts`).
- [x] `syncAutoDailyDeductions` behavior is verified.
- [x] Take flow is traced (`src/utils/medActions.ts` → `consumeDose`).
- [x] Restore flow is traced (`restoreDose` + `doseSkippedHistory`).
- [x] Multi-dose flow is traced (`doseSchedule`, per-dose history).
- [x] Notification scheduling is traced (`useDoseReminderScheduler`, notifications utils, TimedNotificationPublisher).
- [x] Native Android lifecycle is traced (MainActivity, AppForegroundState).
- [x] Exact-alarm permission behavior is documented.
- [x] Existing reboot behavior is inspected (plugin + launch re-arm; no app auto-deduct BOOT receiver).
- [x] Proposed auto-deduction architecture is documented.
- [x] Event contract is defined.
- [x] Idempotency key is defined.
- [x] Source-of-truth model is defined.
- [x] Reconciliation algorithm is defined.
- [x] Take/Auto interaction is defined.
- [x] Restore/Auto interaction is defined.
- [x] Multi-dose isolation is defined.
- [x] Settings behavior is defined.
- [x] Reboot behavior is defined.
- [x] Timezone/DST behavior is discussed.
- [x] Failure/recovery behavior is defined.
- [x] Native storage option is evaluated.
- [x] Resource usage is evaluated.
- [x] Backward compatibility is evaluated.
- [x] Risks and unresolved decisions are listed.
- [x] Future implementation phases are proposed.
- [x] No production code was modified.
- [x] No tests were modified.
- [x] No npm/npx commands were used.

---

*End of Phase 1 document.*

---

## Phase 2 Implementation Decisions

*Implemented: exact-time native scheduling + durable event ledger only. No JS stock reconciliation.*

### Chosen native storage
- **SharedPreferences**
  - Events: `drugtracker_auto_deduction_events_v1` (keys `evt:<occurrenceKey>`)
  - Active schedules (reboot restore): `drugtracker_auto_deduction_schedules_v1` (keys `sch:<occurrenceKey>`)

### Native event schema (JSON per occurrence)
| Field | Notes |
|-------|--------|
| `medicationId` | immutable |
| `doseId` | real id or `legacy` |
| `calendarDate` | YYYY-MM-DD local |
| `scheduledAtEpochMs` | intended wall time |
| `amount` | dose.amount (or legacy dailyDose) |
| `status` | `FIRED` → `RECONCILED` |
| `createdAtEpochMs` | native write time |
| `reconciledAtEpochMs` | set by JS (Phase 3); null while FIRED |

### Canonical key
```text
medicationId + U+001F + doseId + U+001F + calendarDate
```
Implemented in `AutoDeductionContract.occurrenceKey` and mirrored by `autoDeductionOccurrenceKey` in JS.

### Receiver / scheduler / plugin
| Component | Class / name |
|-----------|----------------|
| Receiver | `app.drugtracker.autodeduction.AutoDeductionReceiver` |
| Scheduler | `AutoDeductionScheduler` |
| Ledger | `AutoDeductionEventStore` |
| Capacitor plugin | `AutoDeduction` (`AutoDeductionPlugin`) |
| Bridge JS | `src/utils/autoDeductionNative.ts` |
| App scheduler hook | `src/hooks/useAutoDeductionScheduler.ts` |

### PendingIntent identity
- Request code = `pendingIntentRequestCode(occurrenceKey)` = `(hash ^ 0xAD00DED) & 0x7fffffff` (non-zero)
- Action: `app.drugtracker.action.AUTO_DEDUCTION`
- Separate from Local Notifications request-code space

### Exact alarm API
- `AlarmManager.setExactAndAllowWhileIdle(RTC_WAKEUP, …)` on API 23+
- Permission denied → schedule returns `{ ok: false, error: "exact_alarm_permission_denied" }` (no silent inexact fallback)

### Scheduling model
- One-shot per local calendar occurrence (`calendarDate` + `HH:mm`)
- JS schedules today (if still ahead) + tomorrow per eligible slot
- Receiver, after FIRED insert, schedules the **next local calendar day** at the same HH:mm (not `+24h`)
- Cancel uses the same deterministic PendingIntent identity

### Reboot behavior
- `AutoDeductionReceiver` handles `BOOT_COMPLETED` / `QUICKBOOT_POWERON`
- Restores future alarms from persisted schedule payloads
- Does **not** replay past occurrences; existing ledger rows are preserved
- Limitation: if exact-alarm permission is missing at boot, restore is skipped until app open re-arms

### Permission behavior
- Reuses existing exact-alarm permission gate (`exactAlarmEnabled` from JS)
- When false/null: future auto-deduction alarms are not scheduled; tracked alarms cancelled when explicitly false

### Settings
- Global `globalAutoDeductEnabled` + per-med `autoDeductEnabled === false`
- Disable → cancel future tracked alarms; **historical FIRED events are not deleted**
- Re-enable → schedule only future eligible occurrences (no history replay)

### Unresolved / deferred to later phases
- JS reconciliation of FIRED → stock / ConsumptionLog (Phase 3)
- Interaction matrix with Take / Restore (Phase 4)
- Destructive retention cleanup of old RECONCILED events (must not delete unreconciled)
- DST non-existent local times: relies on `Calendar` set semantics; document after device validation
- Full emulator matrix (foreground / background / killed) — not executed in this environment



### PR #203 review fixes (EventStore lock, PendingIntent identity, schedule durability)

#### EventStore synchronization
- `AutoDeductionEventStore` uses a **process-wide** `private static final Object LOCK`.
- `insertFiredIfAbsent` / `hasEvent` / `markReconciled` / `listEvents` all synchronize on that static lock.
- Multiple EventStore instances (e.g. concurrent receiver deliveries) still serialize check+commit.
- Event writes use `SharedPreferences.commit()` (not `apply()`) so the FIRED row is on disk before the receiver returns.

#### PendingIntent identity (no sole dependence on 32-bit hash)
- Uniqueness comes from **Intent action + data URI**, not from `String.hashCode()`.
- Data URI: `content://app.drugtracker.autodeduction/occurrence/{medId}/{doseId}/{calendarDate}`
  built via `AutoDeductionContract.occurrenceUri(...)` (path segments are Uri-encoded by the builder).
- Request code is a **fixed namespace constant** `PENDING_INTENT_REQUEST_CODE = 0xAD00DED` shared by all auto-deduction alarms; it is **not** the uniqueness source.
- `scheduleOccurrence` and `cancelOccurrence` build the same Intent (same action, same data URI, same request code) so cancel always matches schedule.
- Auto-deduction remains isolated from Local Notifications request-code / channel space.

#### Schedule durability ordering
```text
validate input
  → persist schedule payload with commit()   // reboot recovery metadata first
  → AlarmManager.setExactAndAllowWhileIdle
  → on install failure: remove schedule payload
  → return success
```

Crash / failure model:
| Scenario | Recovery |
|----------|----------|
| Metadata committed, process dies before alarm install | `restoreFutureSchedules()` / boot sees future payload and reinstalls the same PendingIntent identity |
| Alarm installed, process dies | Metadata already durable; boot restore recreates the same identity (idempotent) |
| Metadata committed, alarm install throws | Payload is **removed**; no permanent stale "scheduled" row without an install attempt path |
| Malformed / past payload on restore | Dropped from schedule prefs; past keys are not replayed |

Repeated `scheduleOccurrence` for the same occurrence key overwrites the same metadata key and uses `FLAG_UPDATE_CURRENT` on the same Intent identity → one logical alarm.

Receiver path still: insert FIRED (static-lock idempotent) → `scheduleNextOccurrence` (same durable ordering for the next calendar day).




### Schedule rollback concurrency

Each schedule metadata write stamps a unique `scheduleVersion` (attempt generation token).
This token is **not** part of occurrence identity (`medicationId + doseId + calendarDate`).

Durability order is unchanged:

```text
validate
  → commit schedule metadata (includes scheduleVersion)
  → AlarmManager.setExactAndAllowWhileIdle
  → on failure: conditional rollback
```

Conditional rollback (under process-wide `SCHEDULE_LOCK`):

```text
read current metadata for occurrence key
  → if scheduleVersion still equals this attempt's version → remove
  → else → do nothing (a newer attempt owns the entry)
```

Therefore a stale failed attempt **cannot** delete metadata written by a newer successful (or in-flight) attempt for the same occurrence.

Intentional `cancelOccurrence` and restore cleanup of past/malformed rows still use unconditional remove (user/system intent, not install-failure rollback).

Legacy schedule entries without `scheduleVersion` are not owned by any attempt under the version path; `restoreFutureSchedules` tolerates missing version and assigns a fresh one when rewriting via `scheduleOccurrence`.


### Files touched (Phase 2)
- `native-android/auto-deduction/*`
- `native-android/app/MainActivity.java` (plugin registration)
- `scripts/prepare-android.mjs` (copy sources + manifest receiver)
- `src/utils/autoDeductionNative.ts`
- `src/hooks/useAutoDeductionScheduler.ts`
- `src/App.tsx` (hook wiring only)
- `Tests/hooks/useAutoDeductionScheduler.test.ts`
- `docs/AUTO_DEDUCTION_ARCHITECTURE.md` (this section)

