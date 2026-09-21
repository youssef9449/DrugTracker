# Shared Alarm & Notification Architecture Contracts

## Status

**Normative architecture contract.** This document is the baseline for the shared-infrastructure refactor of the three existing systems:

1. Dose Reminder
2. Critical Stock
3. Exact-Time Auto Deduction

It defines ownership boundaries and invariants before production-code refactoring begins.

**Baseline repository state:** `main` at commit `08370a653d71f7580480b8451fe65606dda8c754`.

**Important:** PR #291 is not the architectural baseline. Its Critical Stock native lifecycle implementation is treated as an interim/experimental implementation only; its architecture must not be copied into the final design.

---

## 1. Architectural goal

The repository must have one shared native exact-alarm infrastructure and one shared notification-delivery infrastructure.

Feature code must contain business rules only.

Target shape:

```
                    Shared Alarm Runtime
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     Dose Reminder    Critical Stock    Auto Deduction
          │                │                │
   reminder business   stock/episode     deduction/event
   + recurrence        + claims          + recurrence
   + consumption      + one-shot         + FIRED ledger
```

Separately:

```
                    Shared Notification Runtime
                           │
                  ┌────────┴────────┐
                  │                 │
            Dose Reminder      Critical Stock
```

Auto Deduction is an exact-time alarm consumer, not a notification consumer.

---

# 2. Non-negotiable ownership rules

## 2.1 Shared infrastructure owns mechanisms, never feature decisions

Shared code may own:

- exact-alarm capability detection
- AlarmManager installation
- AlarmManager cancellation
- PendingIntent construction and matching
- durable alarm-operation metadata
- operation serialization/locking
- durable ordering tokens
- ownership/version tokens
- failure rollback
- boot recovery
- timezone recovery
- exact-alarm permission recovery
- common native lifecycle dispatch
- common native alarm lookup/cancellation primitives
- common notification posting primitives
- common notification permission handling
- common platform capability checks

Shared code must NOT decide:

- whether a medication is Critical
- whether a dose was consumed
- whether a Critical episode has already been notified
- whether Auto Deduction is enabled
- whether a dose reminder should be suppressed today
- whether a recurrence chain is authorized for a feature
- how stock balances are mutated
- when an Auto Deduction FIRED event becomes RECONCILED

Those decisions remain feature-owned.

## 2.2 No feature may duplicate the shared mechanism

After the refactor, there must not be separate implementations of:

- exact-alarm permission checks
- AlarmManager exact scheduling
- generic native cancel
- timezone-to-local-date/time alarm rebasing
- boot restore
- exact-permission restore
- durable ordering-token allocation
- generic scheduling/cancellation locking
- generic PendingIntent identity construction
- generic native alarm metadata persistence

Feature modules may provide data and policy to the shared runtime, but they must not reimplement these mechanisms.

---

# 3. Canonical time model

## 3.1 Calendar date + local wall-clock time are the schedule contract

Every repeating or future calendar-based feature must preserve the user-selected local schedule as the logical source of truth.

Examples:

- Dose Reminder: `doseId + local HH:mm`
- Auto Deduction: `medicationId + doseId + calendarDate + local HH:mm`
- Critical Stock: `medicationId + projected calendarDate + projected local HH:mm`

The absolute epoch milliseconds is a derived installation value, not the business identity.

## 3.2 Timezone changes

For a still-future alarm:

1. retain its logical local calendar date/time;
2. resolve that date/time in the new device timezone;
3. cancel the old absolute alarm;
4. install the replacement exact alarm;
5. update durable alarm metadata only after the new native installation succeeds.

A timezone change must never:

- create a user-facing notification merely because timezone changed;
- convert a future alarm into an unrelated date/time;
- depend on the React app reopening in order to restore the replacement alarm;
- delete durable intent before replacement installation is confirmed.

If the recomputed local occurrence is already past at restoration time, the feature's own recovery policy decides whether to catch up, skip, or advance. The shared runtime must not invent feature semantics.

## 3.3 No fixed 24-hour recurrence assumption

Daily schedules are calendar-day schedules, not fixed 86,400,000 ms intervals. DST/timezone changes must be resolved from local calendar date + local HH:mm.

---

# 4. Canonical alarm identity

## 4.1 Alarm identity must be full and deterministic

The shared runtime must accept an explicit feature-defined identity.

A hash may be used as an optimization or secondary lookup aid, but a finite hash alone is never the authoritative identity.

The authoritative PendingIntent identity must contain the complete logical occurrence identity needed to distinguish two alarms.

Examples:

### Auto Deduction
```
feature = auto-deduction
identity = medicationId + doseId + calendarDate
```

### Dose Reminder
```
feature = dose-reminder
identity = medicationId + doseId
```

### Critical Stock
```
feature = critical-stock
identity = medicationId
```

The shared runtime owns the canonical encoding/namespace rules so that feature code does not invent separate identity schemes.

## 4.2 Identity and notification presentation are separate

The alarm identity identifies scheduled work.

The notification identity identifies the resulting notification.

They must not be conflated.

---

# 5. Shared exact-alarm runtime contract

The shared exact-alarm runtime is responsible for one-shot native scheduling and lifecycle recovery.

Conceptual API:

```text
schedule(request) -> ScheduleResult
cancel(identity) -> CancelResult
verify(identity) -> VerificationResult
restore(reason) -> RestoreResult
listScheduled(featureNamespace) -> SnapshotResult
```

The exact method names/types may be selected during implementation, but the following semantics are mandatory.

## 5.1 Schedule transaction

The schedule operation must be serialized so concurrent schedule/cancel operations for the same identity cannot interleave into an invalid state.

Required ordering:

```
lock
  ↓
validate
  ↓
create authoritative ordering/ownership metadata
  ↓
persist durable schedule intent
  ↓
install exact AlarmManager alarm
  ↓
if install fails → ownership-safe rollback
unlock
```

The shared runtime must never claim a schedule succeeded merely because an API call returned without throwing if the underlying native installation outcome is otherwise known to be unsuccessful.

## 5.2 Cancellation transaction

Required ordering:

```
lock
  ↓
persist durable cancellation/ownership state
  ↓
AlarmManager.cancel
  ↓
remove/retire active metadata
unlock
```

Cancellation must be idempotent.

Cancellation must be serialized against delivery/recovery paths using the same ordering boundary.

## 5.3 Failure semantics

The shared runtime must fail closed.

A failed durable write, unavailable AlarmManager, denied exact permission, or failed native installation must not be reported as successful scheduling.

Rollback must be ownership-safe: a failed old operation must never remove a newer operation's metadata.

---

# 6. Native delivery contract

The shared runtime delivers a feature-owned logical event.

It must not contain business behavior.

A native alarm delivery must carry enough stable identity for the feature adapter to determine the exact occurrence.

## 6.1 Receiver separation

System lifecycle broadcasts and private feature alarm deliveries are separate responsibilities.

System receiver handles only system lifecycle events such as:

- BOOT_COMPLETED
- QUICKBOOT_POWERON where supported
- TIMEZONE_CHANGED
- SCHEDULE_EXACT_ALARM permission state changes where supported

Feature alarm delivery receivers must not be externally invocable by arbitrary applications.

## 6.2 App process is not required

A future exact alarm must be able to reach its intended native delivery path while the React process is not running.

Foreground/resume reconciliation is recovery/repair, not the primary delivery mechanism.

---

# 7. Shared notification runtime contract

Notification code is separate from exact-alarm scheduling.

The shared notification runtime is responsible for:

- notification permission state
- notification posting
- platform-specific notification delivery
- notification identity allocation/lookup
- notification cancellation
- common web fallback behavior
- common Android notification mechanics

It must not decide feature business state.

## 7.1 Notification result contract

The runtime must distinguish:

- accepted by the native platform;
- rejected/failed;
- unavailable on the current platform.

A feature must not persist business state such as "notification already sent" solely because a JS promise resolved without an actual platform acceptance signal when a stronger result is available.

## 7.2 Notification IDs

There must be one centralized notification identity policy.

Feature code must not maintain independent numeric hash/range allocators.

Category namespaces must remain disjoint.

A missing lookup must not allocate a new unrelated ID during cancellation.

The final implementation may use a native tag + ID model or another deterministic platform-supported identity, but feature-level business code must not know the allocation algorithm.

---

# 8. Feature contract: Dose Reminder

## 8.1 Business owner

Dose Reminder owns:

- `medicationId + doseId` slot identity
- explicit `doseSchedule` validation
- reminder enabled state
- configured local HH:mm
- reminder amount/display text
- per-dose consumption suppression
- `skipToday`
- consume → suppress
- restore → re-arm when still valid
- daily recurrence policy
- foreground/background delivery-channel policy
- in-app DoseAlarmModal behavior
- dose reminder notification actions

## 8.2 Exact-alarm responsibilities

Dose Reminder requests the shared runtime to arm one future occurrence for each desired dose slot.

The shared runtime owns the native alarm installation.

Dose Reminder owns deciding what the next desired occurrence is.

## 8.3 Recurrence

Dose Reminder remains a calendar-daily recurring feature.

Its recurrence policy is feature-specific:

- one scheduled occurrence at a time;
- next occurrence at the same local HH:mm on the next calendar day;
- no fixed-interval 24-hour assumption;
- no generic Critical/Auto recurrence semantics.

The native implementation is split across two layers:

- Dose Reminder decides the next desired occurrence;
- the shared Exact Alarm Runtime performs exact timing;
- `DoseReminderAlarmReceiver` performs feature-specific delivery and asks the exact runtime to arm the next occurrence.

The Exact Alarm Runtime does not know that the payload is a dose, does not create notifications, and does not decide recurrence.

## 8.4 Notification delivery

Notification creation/display is a separate concern from exact timing.

The shared Notification Runtime owns:

- Android notification posting;
- Android notification cancellation;
- notification permission state;
- notification channels;
- generic notification action routing;
- foreground/background notification-delivery events.

The feature remains responsible for the notification content and policy it requests.

Dose Reminder therefore follows:

```
Dose Reminder business
      │
      ├── Exact Alarm Runtime ──> DoseReminderAlarmReceiver
      │                              │
      │                              └──> Notification Runtime
      │
      └── notification action/content policy
```

Critical Stock follows the same pattern:

```
Critical Stock business
      │
      └── CriticalStockAlarmAdapter
              │
              ├── Exact Alarm Runtime
              │      └── private adapter delivery
              │              └──> Notification Runtime
              │
              └── schedule / cancel / verify boundary
```

Auto Deduction follows a different path:

```
Auto Deduction business
      │
      └── Exact Alarm Runtime ──> AutoDeductionReceiver
                                      │
                                      └── deduction event
```

Auto Deduction must not import, call, or require Notification Runtime.

## 8.5 Delivery channel

Foreground/background channel selection is Dose Reminder behavior.

The shared Notification Runtime accepts the feature-selected channel definition but does not decide whether Dose Reminder should be silent or sounding.

---

# 9. Feature contract: Critical Stock

## 9.1 Business owner

Critical Stock owns:

- Critical vs Out-of-Stock state interpretation
- the user-configured `warningThresholdDays` rule
- future projected crossing calculation
- one notification opportunity per continuous Critical/Out-of-Stock episode
- persistent claim state
- episode generation / stale async protection
- enabled/disabled preference
- immediate foreground fallback
- exact future one-shot Critical notification policy

## 9.2 Episode contract

The persistent claim remains the business source of truth.

State semantics:

```
Sufficient → Critical/Out-of-Stock
    = start one episode

Critical → Critical
Critical → Out-of-Stock
Out-of-Stock → Critical
    = same episode

Critical/Out-of-Stock → Sufficient
    = episode ended; next episode gets a new opportunity
```

A continuous episode produces at most one Critical notification.

## 9.3 Future alarm contract

Critical Stock is a one-shot future notification, not a recurring daily notification.

The logical schedule identity is medication-level.

The shared alarm runtime owns native timing, identity, cancellation, and lifecycle recovery.

Critical Stock owns the decision to schedule/cancel based on the projected crossing and the episode claim.

## 9.4 Claim semantics

The contract remains:

```
claimed=false, alarmTime=null
    opportunity remains open

claimed=true, alarmTime=T
    future native schedule was accepted at epoch T

claimed=true, alarmTime=null
    foreground notification was accepted
```

A claim is business dedup state, not proof that AlarmManager currently contains the alarm.

Verification of native existence belongs to the scheduler/runtime layer.

## 9.5 Critical payload isolation

Critical notifications are medication-level.

They must never enter the Dose Reminder / DoseAlarmModal action path merely because both systems use notifications.

## 9.6 Native Critical Stock boundary

Critical Stock has one feature-owned native boundary: `CriticalStockAlarmAdapter`.

The adapter sits directly on top of the shared `ExactAlarmRuntime` and exposes only the feature-facing operations required by the scheduler:

- `schedule(medId, localDate, localTime, notification payload)`
- `cancel(medId)`
- `verify(medId)`

Its private delivery and lifecycle-recovery plumbing remains implementation detail inside that adapter. There must not be a second Critical-specific store, lifecycle dispatcher, system receiver, or plugin stack parallel to Auto Deduction.

The business layer remains in TypeScript:

- `criticalNotificationClaims.ts` owns the persistent notification claim state;
- `useStockAlerts.ts` owns episode start/end, claim lifecycle, and the one-notification opportunity;
- generation and stale-async protection remain feature-level scheduler behavior.

The native adapter never creates or advances a Critical episode and never decides whether a notification opportunity is available.

---

# 10. Feature contract: Auto Deduction

## 10.1 Business owner

Auto Deduction owns:

- explicit dose occurrence identity
- medication/dose/calendar-date semantics
- amount authority for automatic deduction
- FIRED event ledger
- pending-fire recovery
- RECONCILED state
- recurrence authorization generation
- schedule ownership/version tokens at the feature layer where required
- cancellation tombstones needed to protect Auto Deduction event semantics
- multi-day catch-up
- bounded fire-persistence retry
- JS stock reconciliation
- durable stock mutation rules

## 10.2 Exact-alarm responsibilities

Auto Deduction requests the shared runtime to schedule/cancel exact occurrences.

The shared runtime must never mutate `currentPills`, create FIRED events, or decide recurrence.

## 10.3 Fire vs cancel

Auto Deduction's stronger fire/cancel semantics remain mandatory.

A stale delivery must be unable to create a new FIRED event after cancellation has linearized.

The shared runtime supplies the scheduling/cancellation serialization primitive; Auto Deduction supplies the feature-specific event-store and generation checks.

## 10.4 No notification dependency

Auto Deduction must remain usable without the notification runtime.

Exact alarm delivery and stock deduction are distinct from user-facing notification delivery.

---

# 11. JavaScript scheduler contract

Each feature scheduler may reconcile desired state in React/TypeScript.

The common scheduler primitives must be shared.

## 11.1 Shared primitives

Provide reusable primitives for:

- serialized async operations
- generation/version guards
- stale-result suppression
- idempotent reconciliation patterns
- native bridge error handling

## 11.2 Feature-specific decisions remain local

Each scheduler decides:

- what desired state means;
- which identities should exist;
- when a schedule must be suppressed;
- what business state to write after successful scheduling/delivery.

There must not be one generic business-state scheduler that attempts to understand all three domains.

## 11.3 Shared JavaScript async primitives

The repeated async hygiene used by Auto Deduction, Dose Reminder, and Critical Stock is implemented with two small utilities:

- `src/utils/async/OperationQueue.ts` — keyed promise serialization. Each feature chooses its own key granularity.
- `src/utils/async/GenerationGuard.ts` — keyed in-memory generation counters for stale-operation checks.

The feature hooks use these primitives directly or through a narrow feature-owned async boundary. `criticalAlarmOperations.ts` owns the single Critical Stock queue instance, while `criticalNotificationClaims.ts` owns claim state only.

These utilities contain no medication state machine, recurrence policy, stock logic, notification policy, or other feature-specific business rules. Do not introduce a universal scheduler abstraction such as `UniversalMedicationScheduler<TBusinessState>`.

---

# 12. Permission contract

## 12.1 Exact-alarm capability

There is one platform capability source for Android exact-alarm permission.

It must normalize Android behavior to a small explicit state set.

All exact-time Android features consume the same capability source.

No feature may silently accept inexact scheduling when its contract requires exact delivery.

## 12.2 Notification permission

Notification display permission is separate from exact-alarm capability.

A feature that requires both must check both.

Auto Deduction does not become disabled merely because notification permission is denied.

## 12.3 User preferences vs OS capability

Feature preferences such as:

- `reminderEnabled`
- `criticalStockAlertsEnabled`
- `autoDeductEnabled`

remain separate from OS permission state.

OS permission is a platform capability, not a feature preference.

---

# 13. Lifecycle recovery contract

The shared lifecycle dispatcher must support:

```
BOOT
TIMEZONE_CHANGED
EXACT_ALARM_PERMISSION_RESTORED
```

Each event triggers feature adapters as needed.

## 13.1 Recovery must be safe after process death

No recovery path may depend on:

- React refs
- module-level JS memory
- an in-memory scheduled-ID set
- the app having been open before the lifecycle event

Durable native metadata is the recovery source.

## 13.2 Recovery must be idempotent

Running the same recovery event more than once must not:

- duplicate alarms
- duplicate notifications
- duplicate Auto Deduction FIRED events
- create a second Critical Stock episode
- advance Dose Reminder business state incorrectly

---

# 14. Source-of-truth matrix

| Concern | Owner |
|---|---|
| Current stock balance | Medication state / stock mutation layer |
| Critical threshold interpretation | Critical Stock |
| Critical episode claim | Critical Stock |
| Dose consumed/restore history | Dose/Medication business layer |
| Auto FIRED ledger | Auto Deduction |
| Auto RECONCILED state | Auto Deduction |
| Exact permission capability | Shared platform runtime |
| Alarm timing | Shared exact-alarm runtime |
| PendingIntent identity encoding | Shared exact-alarm runtime |
| Native schedule/cancel serialization | Shared exact-alarm runtime |
| Boot/timezone/permission lifecycle dispatch | Shared exact-alarm runtime |
| Notification permission | Shared notification runtime |
| Notification posting/cancel mechanics | Shared notification runtime |
| Notification action routing | Shared notification runtime |
| Notification content/policy | owning feature |
| Dose channel policy | Dose Reminder |
| Critical notification content | Critical Stock |
| Auto Deduction business event | Auto Deduction |
| Web notification fallback | Shared notification runtime |

---

# 15. Migration rules

The refactor must follow these rules.

## Rule A — preserve behavior first

The refactor must not intentionally change:

- stock calculations
- Critical threshold semantics
- Critical episode semantics
- dose consumption/restore semantics
- Auto Deduction amount semantics
- Auto FIRED/RECONCILED semantics
- Dose Reminder recurrence semantics

Behavioral improvements must be separate, explicit changes.

## Rule B — extract, then migrate, then delete

For each shared mechanism:

1. identify the proven implementation;
2. extract/genericize it without changing behavior;
3. migrate one feature;
4. add/adjust focused tests;
5. migrate the remaining features;
6. delete the old duplicate implementation only after all consumers use the shared mechanism.

## Rule C — Auto Deduction is a source of implementation patterns, not an architectural namespace

Shared code must not live under an `auto-deduction` package merely because Auto Deduction supplied the original implementation.

The shared layer must have neutral names.

## Rule D — PR #291 native Critical lifecycle is not retained as a parallel system

Do not keep both:

- shared native lifecycle; and
- `CriticalAlarmStore/CriticalAlarmLifecycle/CriticalAlarmSystemReceiver` as a separate second lifecycle stack.

Critical must consume the shared lifecycle runtime.

## Rule E — no giant universal scheduler

Do not create a universal feature-aware scheduler containing Critical Stock, Dose Reminder, and Auto Deduction business logic in one abstraction.

Shared abstractions must remain mechanism-level and narrow.

---

# 16. Target dependency direction

Allowed:

```
Feature business
    ↓
Feature adapter/scheduler
    ↓
Shared JS/native infrastructure
    ↓
Android platform
```

Not allowed:

```
Shared infrastructure
    ↓
Critical Stock rules
    ↓
Dose consumption rules
    ↓
Auto Deduction stock mutation
```

The dependency must point from business-specific code toward generic infrastructure, never the opposite.

---

# 17. Required final architecture properties

The refactor is complete only when all are true:

1. One shared Android exact-alarm implementation exists.
2. One shared exact-alarm permission implementation exists.
3. One shared native lifecycle/recovery implementation exists.
4. One shared scheduling/cancellation serialization primitive exists.
5. One shared alarm identity encoding strategy exists.
6. One shared notification runtime exists, with no AlarmManager scheduling responsibility.
7. Exact Alarm Runtime contains no notification-posting responsibility.
8. Dose Reminder contains its own business/recur/suppression policy only.
9. Critical Stock contains its own episode/claim/crossing policy only.
10. Auto Deduction contains its own event/recovery/stock policy only.
11. Auto Deduction has no dependency on notification posting.
12. Critical Stock does not use DoseAlarmModal/dose action semantics.
13. Dose Reminder does not use Critical claims or Auto FIRED state.
14. Timezone change can rebuild still-future alarms without requiring React to launch.
15. Boot and exact-permission recovery are durable and idempotent.
16. Same medication can simultaneously have Dose Reminder, Critical Stock, and Auto Deduction work without identity collision or cross-feature cancellation.
17. Feature-level hash/ID allocation duplication is removed.
18. Critical Stock has one feature-owned native adapter over the shared Exact Alarm Runtime; no duplicate Critical lifecycle/store/plugin stack exists.
19. Old duplicate infrastructure is deleted after migration.
20. Existing feature contracts remain behaviorally unchanged unless a separate approved change explicitly modifies them.

---

# 18. Implementation order after contract freeze

This contract intentionally does not perform the refactor itself.

The implementation order is:

### Phase 1
Extract shared JS async primitives:

- operation queue
- generation/version guard

### Phase 2
Extract neutral native exact-alarm runtime from the proven Auto Deduction machinery:

- identity
- scheduling
- cancellation
- ordering
- durable metadata
- timezone recovery
- boot recovery
- permission recovery

### Phase 3
Migrate Auto Deduction to the shared runtime without changing its business/event behavior.

### Phase 4
Implement Critical Stock on the shared runtime and remove the parallel PR #291 lifecycle implementation.

### Phase 5
Migrate Dose Reminder to the shared alarm runtime while preserving its recurrence/channel behavior.

### Phase 6
Split Notification Runtime from Exact Alarm Runtime:

- notification posting/cancellation/channels/actions become shared notification infrastructure;
- Dose and Critical retain exact-alarm adapters/receivers that call Notification Runtime at delivery;
- Auto Deduction stays on the exact-alarm path without Notification Runtime;
- remove the old Capacitor LocalNotifications alarm-delivery/recurrence bridge from Android.

### Phase 7
Split the TypeScript notification utility by responsibility without changing notification behavior:

- notification permission/settings behavior is isolated from feature notification code;
- deterministic notification identity stays in a dedicated ID module;
- generic notification presentation mechanics remain separate from feature content/policy;
- Dose Reminder and Critical Stock notification-facing behavior remain feature-specific;
- browser notification fallback remains isolated to the web notification module;
- exact-alarm scheduling/capability concerns remain on the Exact Alarm side rather than in the Notification Runtime layer;
- Auto Deduction remains independent of the notification modules;
- src/utils/notifications.ts is reduced to a thin compatibility re-export facade with no notification implementation.

### Phase 8
Collapse the Critical Stock native boundary to one feature adapter over the shared Exact Alarm Runtime:

- `CriticalStockAlarmAdapter` is the only Critical Stock native feature boundary;
- its schedule/cancel/verify operations use the shared exact-alarm runtime;
- private delivery and lifecycle-recovery details do not become a second Critical-specific runtime;
- `criticalNotificationClaims.ts` and `useStockAlerts.ts` remain responsible for episode, claim, generation, and one-notification-per-episode business semantics;
- stale Critical native implementations are removed after all consumers use the consolidated adapter.

### Phase 9
Run final architecture/dead-code audit and update architecture documentation.

---

# 19. What is explicitly NOT decided by this document

This contract intentionally leaves implementation-level choices open where several equivalent implementations may satisfy the contract, including:

- exact Java class/file names;
- whether the shared runtime uses one dispatcher class or several narrow classes;
- exact PendingIntent URI syntax;
- exact notification tag/ID representation;
- exact Capacitor bridge method names.

Those choices must be made during implementation without violating any invariant in this document.

---

## Contract freeze rule

From this point forward, any refactor proposal or agent task for Dose Reminder, Critical Stock, Auto Deduction, exact alarms, or their notification plumbing must be checked against this document.

A proposed change that moves business policy into shared infrastructure, creates a duplicate lifecycle/scheduling implementation, or changes one of the feature contracts without an explicit behavior-change task is out of scope.
