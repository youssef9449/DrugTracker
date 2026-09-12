# Phase 3B — Multi-dose stock & history (reference)

Approved accounting model (do not redesign casually). Projection remains:

```text
fullDueUnits = pastDueUnits + todayDueUnits
effectiveCurrentPills = max(0, currentPills - fullDueUnits)
```

`currentPills` is a settlement snapshot; the UI always uses `effectiveCurrentPills`.

## Consumption maps

| Field | Role |
|-------|------|
| `doseConsumption` | Last known consumed date per `doseId` (compat / “today?”) |
| `doseConsumptionHistory` | Authoritative list of consume dates per `doseId` for catch-up |

### Pre-3B data

Older installs may only have `doseConsumption` (last-date only). Readers treat that value as **one** known consumed date. Dates overwritten by the old model cannot be reconstructed; the app must not invent them.

### History retention

History is local, lightweight (`YYYY-MM-DD` strings). It grows with consume events. Orphan `doseId`s are pruned when removed from the schedule. There is **no** date-based retention/deletion policy; scale does not currently justify one.

## Historical catch-up

- **Known history:** a slot recorded as consumed on date D is not auto-deducted again for D.
- **Unknown history:** no record for that dose/date does **not** mean “user did not consume.” It means the store cannot distinguish unrecorded consumption from no consumption. The implementation uses a **deterministic full-schedule fallback** valued with the **current** schedule amounts for unrecorded slots.

### Amount / time edits

Stable `doseId`s preserve recorded consume **dates**. Changing amount or time does **not** rewrite those dates. Unrecorded historical slots still use the **current** schedule definition when catch-up runs — this is a documented fallback, not historical reconstruction of past configuration.

## Multi-dose vs legacy

- Multi-dose: per-slot times, per-slot consume history, per-dose reminders/snooze (`medId::doseId`).
- Legacy (`doseSchedule` absent): `dailyDose`, `reminderTime`, `lastConsumedDate`, `LEGACY_DOSE_ID`, med-only snooze.

## `countDueAutoDoses`

- Legacy: integer **day** count.
- Multi-dose: integer **dose-event** (slot) count.
- Stock math always uses `fullDueUnits`, never `countDueAutoDoses × dailyDose` for multi-dose.
