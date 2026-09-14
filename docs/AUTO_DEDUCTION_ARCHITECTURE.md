# Exact-Time Automatic Dose Deduction — Architecture

This document describes the **current** DrugTracker exact-time auto-deduction system as implemented on `main`. It is a specification of runtime behavior derived from the code, not a PR changelog.

Primary code map:

| Layer | Location |
|-------|----------|
| JS schedule bridge | `src/utils/autoDeductionNative.ts`, `src/hooks/useAutoDeductionScheduler.ts` |
| Native contract / store / scheduler / receiver | `native-android/auto-deduction/` |
| Capacitor plugin | `AutoDeductionPlugin.java`, registered from `MainActivity` |
| Reconciliation | `src/utils/autoDeductionReconciliation.ts` |
| Orchestration + envelope | `src/utils/runAutoDeductionReconciliation.ts` |
| Stock mutation gate | `src/utils/autoDeductionStockGate.ts` |
| Lifecycle | `src/hooks/useExactAutoDeductionReconciliation.ts`, `src/App.tsx` |
| Legacy day settlement / projection | `src/utils/dateCalculations.ts` (`syncAutoDailyDeductions`, `effectiveCurrentPills`, `historicalRangeDueUnits`) |

---

## 1. Purpose and scope

**Problem:** Dose times must fire at exact wall-clock times even when the app process is not running. Stock must still update safely when the user returns, without double-counting the same dose.

**Pipeline layers:**

```text
Scheduling
  → Native exact alarm execution
  → Durable native event storage
  → JS reconciliation
  → Durable JS persistence (medications + logs)
  → Native acknowledgement
  → Projection (display balance)
  → Recovery (restart / partial failure)
```

**In scope:** exact-time auto deduction for medications with auto-deduct enabled (global and per-med), multi-dose and legacy single-dose identities, interaction with existing day-level settlement (`syncAutoDailyDeductions`).

**Out of scope (not redesigned here):** full Take / Restore product rules (Phase 4 territory), notification channels/sounds, reminder UI, WorkManager-based exact scheduling, SQLite.

---

## 2. Source of truth

### Native is responsible for

- Installing one-shot exact alarms (`AlarmManager.setExactAndAllowWhileIdle` / `setExact`)
- Firing via a dedicated `BroadcastReceiver` (`AutoDeductionReceiver`)
- Persisting durable events in SharedPreferences (`drugtracker_auto_deduction_events_v1`)
- Persisting schedule metadata for reboot restore (`drugtracker_auto_deduction_schedules_v1`)
- Restoring future alarms on `BOOT_COMPLETED` / quick boot
- Exposing bridge methods: schedule, cancel, list fired, list all, mark reconciled, restore schedules, exact-alarm permission probe
- PendingIntent identity: `ACTION_AUTO_DEDUCTION` + data URI derived from the full occurrence key (not hash-only uniqueness)

### JS is responsible for

- Business stock mutation (`Medication.currentPills`)
- Consumption / skip history and `lastConsumedDate`
- `lastSyncDate` day-settlement horizon compatibility
- Consumption logs (`type: 'auto_daily'` for exact events with deterministic ids)
- Idempotency decisions (`isExactAutoOccurrenceApplied`)
- Legacy bulk settlement (`syncAutoDailyDeductions`)
- Display projection (`effectiveCurrentPills`)
- Triggering reconciliation after hydration / on resume

### Native does **not**

- Mutate `currentPills` or any JS business state
- Write `localStorage`
- Run settlement / projection math
- Depend on WebView being alive when the alarm fires

When the alarm fires, native only writes a **FIRED** durable row (insert-if-absent) and may schedule the next one-shot occurrence. Stock changes only later, in JS.

---

## 3. End-to-end lifecycle

```text
Medication schedule (doseSchedule or legacy reminderTime + dailyDose)
        ↓
JS useAutoDeductionScheduler (after hydrated, exact alarm granted)
        ↓
Capacitor AutoDeduction.scheduleOccurrence(...)
        ↓
Native: schedule metadata commit + AlarmManager install (serialized under SCHEDULE_LOCK)
        ↓
Alarm fires at scheduled wall time
        ↓
AutoDeductionReceiver
        ↓
EventStore.insertFiredIfAbsent(...)  → status FIRED
        ↓
[No stock mutation]
        ↓
App process starts or resumes
        ↓
Hydration: permissions + exact-alarm probe + initNativeBridge() → setHydrated(true)
        ↓
useExactAutoDeductionReconciliation (hydrated && !isFirstRun)
        ↓
withAutoStockMutationGate → load fresh durable meds + logs from localStorage
        ↓
listFiredAutoDeductionEvents()
        ↓
reconcileFiredEvents (sort by scheduledAtEpochMs, then occurrence key)
        ↓
per event: validate → idempotency → applyExactAutoEventToMedication (or no-op)
        ↓
deterministic exact-auto log if applied
        ↓
mutating path: write envelope → persist meds → persist logs → markReconciled → clear envelope
        ↓
React state updated from committed durable result
```

### Transition notes

1. **Schedule** — One-shot alarms only; next occurrence is scheduled from the receiver / scheduler helpers using local calendar date arithmetic (not “previous + 24h” polling).
2. **Fire** — Receiver ignores malformed extras; insert is idempotent per occurrence key.
3. **Reconcile** — Never runs before `hydrated`; first-run seed inventory skips auto effects (`isFirstRun`).
4. **Apply** — Uses `event.amount`, not `med.dailyDose`, for the stock delta of that occurrence.
5. **Acknowledge** — `markReconciled` sets native status to `RECONCILED` with `reconciledAtEpochMs`.

---

## 4. Native event states

| Status | Meaning in code |
|--------|-----------------|
| **FIRED** | Alarm path persisted the occurrence; JS has not completed acknowledgement for this row (or mark failed and will retry). |
| **RECONCILED** | JS called `markReconciled` successfully after the JS-side outcome for that occurrence (apply or intentional no-op ack). |

There is no intermediate native status beyond these two in the current store.

Event payload fields (as used across native + bridge):  
`medicationId`, `doseId`, `calendarDate`, `scheduledAtEpochMs`, `amount`, `status`, `createdAtEpochMs`, `reconciledAtEpochMs`.

---

## 5. Occurrence identity

Canonical identity:

```text
medicationId + doseId + calendarDate
```

- Storage / PendingIntent URI / JS key helpers all derive from this triple.
- **Not** used as identity: array index, time string alone, `dailyDose`, “first dose”, “next dose”.

**Legacy / single-dose:** missing or empty `doseId` is normalized to `LEGACY_DOSE_ID` (`__legacy_daily__` from `src/utils/notifications.ts`) in JS reconciliation.

JS key helper: `autoDeductionOccurrenceKey` (unit separator `\u001f`).  
Native: `AutoDeductionContract.occurrenceKey` / `occurrenceUri`.

---

## 6. Multi-dose semantics

Each schedule slot has its own `doseId`, `amount`, and `time`. An exact event carries the amount that was scheduled into the alarm payload.

Example:

```text
2026-09-13
  morning  amount=2
  evening  amount=3
```

- A **morning** FIRED event applies **2** only and records consumption for `morning` on that date.
- **Evening** remains unapplied until its own event (or other paths such as legacy day settlement of unrecorded slots).
- Reconciliation never substitutes `med.dailyDose` for `event.amount`.

---

## 7. Exact-event historical settlement window

When applying an exact event on calendar day **D**, gated medications may still need earlier unsettled days folded into `currentPills`. That prior window is **not** full `pastDueUnits` through today.

**Rule (current code in `applyExactAutoEventToMedication`):**

```text
Historical units folded before the event amount =
  historicalRangeDueUnits(med, lastSyncDate, D)
  i.e. days strictly after lastSyncDate AND strictly before D

Then:
  currentPills := max(0, currentPills - priorUnits - event.amount)
```

**Why exclude day D:** Including D in `pastDueUnits` (through today) would charge every unrecorded slot on D, then charge `event.amount` again for the same occurrence → double deduction (classic bug: 10 → 6 instead of 10 → 8 for a 2-unit event).

**Example:**

```text
today        = 2026-09-14
lastSyncDate = 2026-09-12
event day    = 2026-09-13
event amount = 2
currentPills = 10
```

Result after apply: **8**, not 6.

**Sibling multi-dose on D:** morning event does not subtract evening’s 3 via historical settlement of day D.

If there are due units on days between lastSync and D (e.g. lastSync = 09-10, event = 09-13), those prior days **are** still folded via `historicalRangeDueUnits`.

After folding prior units, `lastSyncDate` may advance to the day before D (end of that exclusive-end window)—not automatically to “today”.

---

## 8. Legacy compatibility (`syncAutoDailyDeductions`)

Legacy day settlement and exact reconciliation share stock, but use different markers.

### Native-first

```text
native FIRED → exact apply (markers + amount) → later syncAutoDailyDeductions
→ historicalDayDueUnits skips consumed slots → no second charge of that occurrence
```

### Legacy-first

```text
sync advances lastSyncDate over past days and reduces currentPills
→ later FIRED for a day with calendarDate < today && calendarDate <= lastSync
→ isExactAutoOccurrenceApplied → already_applied → mark only, no stock change
```

**`lastSyncDate` is a day-settlement horizon**, not a per-dose event ledger. Per-dose truth uses `doseConsumption` / `doseConsumptionHistory` / `doseSkippedHistory` (and legacy `lastConsumedDate`).

Both hydration sync and exact reconciliation enter `withAutoStockMutationGate` so they serialize and each job loads **fresh durable** meds/logs from localStorage—not a React snapshot captured before the gate.

---

## 9. Idempotency layers

| Mechanism | Role |
|-----------|------|
| Consume / skip history | Occurrence-level: `isDoseConsumedOnDate` / `isDoseSkippedOnDate` |
| `lastConsumedDate` | Legacy single-dose terminal marker for a calendar date |
| `lastSyncDate` horizon | Past day already folded by day settlement (`calendarDate < today && calendarDate <= lastSync`) |
| Deterministic log id | `exact-auto:{medicationId}:{doseId}:{calendarDate}` — retries do not append a second log row for the same occurrence |
| Native `insertFiredIfAbsent` | At most one FIRED/RECONCILED row per occurrence key |
| Gate serialization | Prevents concurrent apply from independent callers |

Duplicate FIRED rows in one batch: first apply wins; second sees marker / log → `already_applied`.

---

## 10. Mutation gate (fresh durable state)

`withAutoStockMutationGate` in `src/utils/autoDeductionStockGate.ts`:

1. Serialize jobs (process-local promise chain).
2. At job start, **load** `android_med_tracker_items_v2` and `android_med_tracker_logs_v2`.
3. Run mutation against that state.
4. **Commit** durable writes when the caller/orchestrator persists.
5. React `setMedications` / `setLogs` follow the **committed** result.

React UI state is not the source of truth inside the gate. A pre-gate `medications` closure must not drive stock math.

---

## 11. Persistence, envelope, and crash safety

Orchestrator: `runAutoDeductionReconciliation`.

**Mutating path protocol:**

```text
write envelope (android_med_tracker_exact_auto_envelope_v1)
  → write medications + logs (durable)
  → mark native RECONCILED for each toAcknowledge
  → clear envelope
```

**Option B (current) for partial native ack:**  
After meds+logs are successfully written, the envelope is cleared even if some `markReconciled` calls fail. Remaining native **FIRED** rows are recovered on the next run via `listFired` + JS markers / deterministic logs → `already_applied` → mark again without a second stock or log mutation.

| Failure | Effect | Recovery |
|---------|--------|----------|
| App closed when alarm fires | Native FIRED persists | Next start/resume reconciliation |
| Crash before envelope / meds+logs commit | No durable JS apply | Next run applies once from FIRED |
| Crash after JS commit, before/during marks | Markers + logs durable; some events may stay FIRED | Next run acknowledges only |
| Partial mark success | Some RECONCILED, some FIRED | Retry marks; no double stock |
| Meds or logs write fails | Envelope kept (mutating path); no mark | Envelope recovery on next run |
| Medication missing | `skipped_missing_med` + acknowledge | No stock mutation, no infinite FIRED loop |
| Global or per-med auto-deduct disabled | `skipped_disabled` + acknowledge | No stock mutation |
| Invalid amount | `skipped_invalid` + acknowledge | No stock corruption |
| Duplicate FIRED | Idempotency | Single deduction + single exact-auto log |

Acknowledge-only paths (already applied / disabled / missing med) do not require an envelope; they only call `markReconciled`.

---

## 12. Deterministic exact-auto log id

```text
exact-auto:{medicationId}:{doseId}:{calendarDate}
```

(`exactAutoLogId` in `autoDeductionReconciliation.ts`; dose id normalized with `LEGACY_DOSE_ID` when needed.)

Legacy bulk logs from `syncAutoDailyDeductions` still use generated ids; only **exact** Phase-3 applies use this deterministic form.

---

## 13. Hydration and when reconciliation runs

From `App.tsx` and hooks:

- `hydrated` becomes true only after permission init, exact-alarm capability init, and **`initNativeBridge()`** settle (bridge failures are logged; hydration still completes so the app is usable).
- `usePersistentEffect` for meds/logs is gated on `hydrated`.
- Legacy `syncAutoDailyDeductions` on session start is gated on `hydrated` and uses the stock gate with fresh durable state.
- `useExactAutoDeductionReconciliation` runs when `hydrated && !isFirstRun`, and again when `resumeTick` changes (app resume).
- Empty UI (“no medications”) is **not** a hydration signal; it can render whenever the medication list is empty while the bridge is still pending.

---

## 14. Resume and reboot

**Resume:** App registers resume handling; `resumeTick` bumps → reconciliation may list remaining FIRED events.

**Reboot:** `AutoDeductionReceiver` handles `BOOT_COMPLETED` / quick boot → `restoreFutureSchedules()` reinstalls future alarms from schedule SharedPreferences. Past FIRED events remain in the event store until JS acknowledges them.

Native fire does **not** update stock in the background; stock updates when JS reconciliation runs.

---

## 15. Committed stock vs projected balance

| Concept | API | Role |
|---------|-----|------|
| Committed snapshot | `Medication.currentPills` (+ history fields) | Persisted inventory after settlement / exact apply / take / etc. |
| Display / effective | `effectiveCurrentPills(med, today, now)` | Snapshot minus still-due projection (past unsettled + today’s elapsed unconsumed slots when auto-deduct is on) |

After an exact occurrence is applied, consumption markers remove that slot from `todayDueUnits` / historical due helpers so projection does not subtract the same occurrence again on top of the snapshot.

---

## 16. Error / recovery matrix (summary)

| Situation | Durable effect | Next step |
|-----------|----------------|-----------|
| App closed at fire time | FIRED in native prefs | Reconcile on start/resume |
| JS interrupted mid-reconcile | FIRED remains; partial JS state only if persist succeeded | Restart reconciliation |
| Partial JS persist | Envelope recovery path | Rewrite meds/logs from envelope, then mark |
| Partial native ack | Some FIRED remain | already_applied + mark |
| Deleted medication | Ack without stock change | Terminal for that event |
| Auto-deduct disabled | Ack without stock change | Terminal |
| Duplicate FIRED | Idempotent | One stock delta, one exact-auto log |

---

## 17. Validation status (honest)

### Proven in repository (static / unit tests)

- Occurrence identity and multi-dose `event.amount`
- Event-day exclusion from historical settlement (post–#207)
- Native-first and legacy-first no double deduct (test models)
- Deterministic log ids and duplicate batch handling
- Gate fresh-state sequencing (test hooks)
- Partial mark recovery models
- Hydration ordering test observes reconciliation runner, not EmptyState text

### Not proven in this project environment

- **Android device / emulator end-to-end:** AlarmManager fire → FIRED → cold start → single stock apply → RECONCILED under real Doze / reboot conditions.
- Full instrumented UI E2E on hardware.

Until device validation is run, treat runtime behavior as **implemented and unit-covered**, not field-verified on Android.

---

## 18. Phase boundary (product)

| Phase | Status in architecture terms |
|-------|------------------------------|
| Native exact fire + durable FIRED | Implemented |
| JS reconciliation + persistence + ack | Implemented |
| Event-day settlement window fix | Implemented |
| Full Take / Restore product integration with exact auto | Not this document’s feature set (future work) |
| Notification architecture | Independent of stock auto-deduction path |

---

## 19. Invariants (checklist)

1. Same `(medicationId, doseId, calendarDate)` → at most one exact auto stock deduction and at most one deterministic exact-auto log.
2. Native never mutates JS stock.
3. Historical settlement for an exact event on day D never charges day D’s slots via `pastDueUnits`-to-today; only prior days, then `event.amount`.
4. Multi-dose siblings on the same date remain independent until each is applied or otherwise marked.
5. `lastSyncDate` horizon prevents re-applying exact events for days already folded by legacy settlement.
6. Reconciliation and legacy sync share a fresh-state mutation gate.
7. Native FIRED remains retryable until mark succeeds; JS markers prevent double apply on retry.
