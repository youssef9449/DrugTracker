# Exact-Time Automatic Dose Deduction — Architecture

Current-state technical specification for DrugTracker’s exact-time automatic dose deduction. Behavior is defined by the implementation on the repository’s main line; this document tracks that implementation.

> This is not a product roadmap. Phase boundaries and deferred items are recorded so future work does not re-open closed correctness contracts.

## Scope

Native exact-time auto-deduction for scheduled dose occurrences. One-shot AlarmManager alarms, durable schedule metadata, FIRED ledger, cancellation tombstones, and lifecycle restore. JS is the product orchestrator; native owns durable schedule and fire authority for the exact path.

## Non-goals (this subsystem)

- Stock mutation on the native path (JS remains source of truth for inventory).
- WorkManager / polling / foreground-service scheduling.
- Redesigning Phase 3/4 boundaries.

## Occurrence identity

Canonical key: `medicationId + doseId + calendarDate` (ISO-like `YYYY-MM-DD`).
PendingIntent identity uses action + data URI derived from that key; request code is a fixed namespace constant.

## scheduleVersion and SCHEDULE_LOCK

- `scheduleVersion` is an attempt token (`{millis}-{seq}-{uuid}`), not part of occurrence identity.
- Generated under `SCHEDULE_LOCK` so ordering vs cancellation matches serialized lock order.
- Used for ownership-safe conditional rollback when AlarmManager install fails after metadata write.

## FIRED and pending-fire

Main FIRED ledger and pending-fire recovery are durable SharedPreferences namespaces. Receiver and restore paths consult them before synthesizing fire outcomes.

### InsertFired result → schedule next

| Insert result | Schedule next |
|---------------|---------------|
| CREATED | Yes |
| ALREADY_EXISTS | Yes (idempotent) |
| FAILED | No |

### Restore / cancel

- `scheduleOccurrenceLocked` holds `SCHEDULE_LOCK` for ownership check + metadata + AlarmManager install (restore uses `requiredVersion`). The authoritative `scheduleVersion` (`{millis}-{seq}-{uuid}`) is generated **inside** this lock so its durable ordering token reflects serialized operation order, not the wall-clock time at which a thread waited for the lock.
- Cancel writes a durable cancellation tombstone (occurrence identity + the same style of ordering token) before AlarmManager.cancel and schedule-metadata removal — also under `SCHEDULE_LOCK`. The token is generated with `VERSION_SEQ` so same-millisecond schedule vs cancel is strictly ordered and remains comparable after process death.
- **Effective cancellation** is evaluated from durable state only (`isOccurrenceCancelled`):
  - tombstone present and no schedule metadata → cancelled
  - both present → compare ordering tokens by (millis, seq); a strictly newer schedule supersedes the tombstone (active); a strictly newer cancel remains cancelled
  - no tombstone → not cancelled
- Cancelled occurrences are blocked in **both** lifecycle restore and `AutoDeductionReceiver` fire handling: no synthetic FIRED, no next recurrence. A stale alarm that races with cancel is ignored when the tombstone is durable.
- A later legitimate `scheduleOccurrence` writes new schedule metadata (lock-ordered `scheduleVersion`) then best-effort clears the tombstone. If tombstone removal fails, version ordering still treats the newer schedule as active so reboot/restore and fire delivery do not suppress it.
- Past schedule metadata is removed only when FIRED exists or pending was durably recorded (genuine fire recovery), never when the occurrence is effectively cancelled.

### Platform limitations

- Force-stop cancels alarms on stock Android; recovery is boot restore and/or JS reschedule after next launch.
- OEM aggressive battery managers may delay exact alarms; architecture remains reconstructible from durable schedule metadata + FIRED/pending stores.
- Pending and main FIRED both use SharedPreferences (separate files); they are separate durable namespaces, not a different storage technology.
- Full Android emulator/device matrix (Doze, OEM force-stop, permission toggle) is environment-dependent; see Validation status above.

---

## Future work (narrow)

Further product-level completion of the Take / Restore × exact-native-auto interaction matrix beyond the occurrence-level compatibility already shared via consumption/skip markers. Notification and scheduling UX remain outside this subsystem’s stock path.
