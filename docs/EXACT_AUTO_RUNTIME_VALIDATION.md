# Exact Auto deduction pipeline — runtime validation

## Purpose

This is the runtime validation record for the Exact-Time Automatic Dose Deduction pipeline (Phase 5, P5-2). Unit tests and static inspection of the Java/TS sources prove that the code *should* behave as documented in `docs/AUTO_DEDUCTION_ARCHITECTURE.md`; they **cannot** prove any of the following on a real Android runtime:

- that `AlarmManager` actually delivers the exact alarm at the requested time
- that `AutoDeductionReceiver` runs while the process is in the background or after it was killed
- that the FIRED event is actually persisted durably on fire
- that JS reconciliation reads FIRED after a cold start
- that the stock balance decreases exactly once
- that the event becomes RECONCILED
- that reboot recovery, exact-alarm permission recovery, and multiple exact occurrences behave as designed on real hardware

This document follows the same honesty conventions as `docs/ANDROID_NOTIFICATION_RUNTIME_VALIDATION.md`: compilation, Gradle success, and unit coverage are **not** runtime proof. Every matrix Result below is filled only from a real observed Android runtime. Nothing in this record changes production architecture.

## Intended pipeline under validation (do not change)

Native `AlarmManager.setExactAndAllowWhileIdle` one-shot per occurrence (`AutoDeductionScheduler`) → delivery into `AutoDeductionReceiver.onReceive` (background thread via `goAsync()`) → durable **FIRED** evidence + occurrence-idempotent Native stock mutation (`AutoDeductionStockStore`) → next recurrence only after Native stock completion → native wake-up when JS is available → JS reconciliation/convergence (`useExactAutoDeductionReconciliation` → `runAutoDeductionReconciliation`) → exactly one exact log/consumption marker without a second stock subtraction → native **FIRED → RECONCILED** acknowledgement (`AutoDeductionPlugin.markReconciled`).

Occurrence identity: `medicationId + doseId + calendarDate` (`AutoDeductionContract`). Boot / timezone / permission restore: `DrugTrackerAlarmSystemReceiver` + `AutoDeductionScheduler.restoreFutureSchedules`.

## Validation environment — attempt of 2026-09-18

| Field | Value |
| ----- | ----- |
| Date | 2026-09-18 |
| Host | Cloud sandbox container (Debian 13, 2 vCPU, 3.9 GiB RAM, ~8 GiB free disk) |
| App commit | `ec22bb1143e612d9f153245a73edf54391bfe268` (PR #263 head, `fix/phase5-failed-exact-auto-no-ack`) |
| Android device | **None** (`adb devices` → empty) |
| Android SDK | cmdline-tools 12.0 (`commandlinetools-linux-11076708`), platform-tools 37.0.1, emulator package — all installed successfully |
| Android emulator | Installed but **cannot start**: no hardware acceleration available |
| KVM | `/dev/kvm` absent; CPU exposes **no** `vmx`/`svm` flags |
| binder | `/dev/binder` and `/dev/ashmem` absent (container-based Android such as Waydroid/Anbox impossible) |
| APK build | **Not attempted** — with no bootable runtime there is nothing to install/execute an APK on (see below) |

### Provisioning steps actually executed (with real outputs)

1. Downloaded and extracted Android cmdline-tools (`commandlinetools-linux-11076708_latest.zip`, ~154 MB) — **success**.
2. `sdkmanager --licenses` accepted; `sdkmanager "platform-tools" "emulator"` — **success** (`emulator/` and `platform-tools/` populated).
3. `adb version` → `Android Debug Bridge version 1.0.41`, `Version 37.0.1-15733141`; `adb devices -l` → `List of devices attached` (empty) — no physical device is reachable from the sandbox.
4. `emulator -accel-check` → **exit code 3**:

   ```
   accel:
   3
   KVM requires a CPU that supports vmx or svm
   accel
   ```

5. `grep -cE "vmx|svm" /proc/cpuinfo` → `0`; `ls /dev/kvm` → `No such file or directory`.
6. `ls /dev/binder /dev/ashmem` → both `No such file or directory`.

### Where provisioning stopped, and why nothing further is possible here

- The Android emulator on x86_64 Linux **requires KVM**. The CPU exposes no virtualization extensions and `/dev/kvm` does not exist, so **no system image can boot**. `emulator -accel-check` (exit 3, quoted above) is the emulator's own diagnosis.
- Container-based Android (Waydroid/Anbox) requires binder kernel interfaces, which are absent.
- No physical device can be attached to the cloud sandbox (`adb devices` → empty).
- A system image / AVD was **not** downloaded, and `gradlew assembleDebug` was **not** run: with no bootable runtime, an APK has nothing to be installed or executed on, so these steps cannot advance any scenario. The documented build flow in `BUILD_APK.md` also relies on the npm-based web-asset toolchain, which is out of scope for this task's constraints.

**Consequence: scenarios 1–7 are BLOCKED / NOT EXECUTED in this environment.** No row below may be read as PASS. This mirrors the honesty rule of `docs/ANDROID_NOTIFICATION_RUNTIME_VALIDATION.md`: *"If no emulator/device/adb is available, mark the entire runtime section BLOCKED / NOT EXECUTED."*

## Scenario matrix (2026-09-18 attempt)

`Scheduled` / `Fired` columns would carry the actual device clock times observed during a real run; no clock times exist for this attempt.

| Scenario | Scheduled | Fired | FIRED persisted | Stock deducted | Log count | RECONCILED | Result |
| -------- | --------- | ----- | --------------- | -------------- | --------- | ---------- | ------ |
| 1. Foreground exact fire | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | BLOCKED — no Android runtime available |
| 2. Background (process alive) | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | BLOCKED — no Android runtime available |
| 3. Killed / cold process | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | BLOCKED — no Android runtime available |
| 4. Multiple exact occurrences | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | BLOCKED — no Android runtime available |
| 5. Reboot recovery | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | BLOCKED — no Android runtime available |
| 6. Exact-alarm permission recovery | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | BLOCKED — no Android runtime available |
| 7. Duplicate FIRED delivery | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | BLOCKED — no Android runtime available |

## Scenario procedures (for a real emulator/device run)

Each scenario lists the reproducible procedure, what PASS requires, and the status of the 2026-09-18 attempt. `app.drugtracker` is the package id (`capacitor.config.ts`). Log tags actually used by the implementation: `AutoDeductionScheduler`, `AutoDeductionReceiver`, `DrugTrackerAlarmSystemReceiver`, `AutoDeductionEventStore`, `AutoDeductionPlugin`, `AutoDeductionLifecycle`.

Useful observation commands:

```bash
adb logcat -s AutoDeductionScheduler:D AutoDeductionReceiver:D DrugTrackerAlarmSystemReceiver:D \
  AutoDeductionEventStore:D AutoDeductionPlugin:D AutoDeductionLifecycle:D
```

JS-side state (schedules, fired/reconciled events, stock, logs) is observable through the app UI plus the `AutoDeduction` Capacitor bridge methods (`listScheduledOccurrences`, `listFiredEvents`, `listEvents`, `canScheduleExactAlarms`, `restoreFutureSchedules`) via `chrome://inspect` on a debug build.

### Scenario 1 — Foreground exact fire

1. Clean install: `adb uninstall app.drugtracker` → `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`; launch once; grant notification + exact-alarm permissions.
2. Create a medication: Auto Deduct **ON**, exactly one dose, known amount, dose time **2–3 minutes** ahead. Record scheduled time.
3. Verify the exact native schedule exists (`listScheduledOccurrences`, or `AutoDeductionScheduler` logs).
4. Keep the app in the foreground; wait for the alarm. No polling: observe the single delivery (logcat `AutoDeductionReceiver`).
5. Record actual fire time; verify durable FIRED (`AutoDeductionEventStore` log + `listFiredEvents`).
6. Verify the Native stock balance decreases by exactly the dose amount **once** even with JS/WebView unavailable, then after foreground hydrate/resume verify `Medication.currentPills` converges to the Native balance, exactly **one** `exact-auto:` log exists, and the event transitions to **RECONCILED** (`listEvents`).

**PASS requires** all of: schedule observed, fire at requested time, FIRED persisted, single deduction, single log, RECONCILED — with real recorded times.
**2026-09-18 attempt:** nothing executed on a device; blocked at runtime provisioning (see Validation environment). Unproven: every step above.

### Scenario 2 — Background (process alive)

Repeat scenario 1, but press **Home** (do not force-stop) before the dose time. Verify the same chain: alarm → FIRED → reconciliation → single deduction → single log → RECONCILED. Reconciliation is event-driven (hydrate/resume/midnight triggers only — `useExactAutoDeductionReconciliation.ts`); observe the fire via logcat in the background, then bring the app to the foreground to observe reconciliation and record both timestamps. **PASS requires** the same observations as scenario 1 with the process in the background at delivery.
**2026-09-18 attempt:** NOT EXECUTED — blocked at runtime provisioning.

### Scenario 3 — Killed / cold process

1. Schedule a near-future dose as in scenario 1; confirm the schedule exists.
2. Kill the process before the dose time: `adb shell am force-stop app.drugtracker` (verify `adb shell pidof app.drugtracker` is empty).
3. Wait for the alarm **without** reopening the app; observe `AutoDeductionReceiver` fire in a fresh process via logcat; verify FIRED is persisted durably.
4. Relaunch the app; verify reconciliation on hydrate, stock decreased **exactly once**, exactly **one** log, event **RECONCILED**.

This is the cold-process FIRED path: AlarmManager delivery → receiver without a live JS runtime → durable FIRED → JS reconciliation on next start. **PASS requires** all seven observations including the post-cold-start reconciliation.
**2026-09-18 attempt:** NOT EXECUTED — blocked at runtime provisioning.

### Scenario 4 — Multiple exact occurrences

1. Create one medication with **two** doses (distinct dose ids, distinct times a few minutes apart, both near-future).
2. Verify both occurrences are independently scheduled (one one-shot alarm each; independent identity per `AutoDeductionContract`).
3. Let each fire at its own time; verify each FIRED is persisted, each deduction applies **once**, log count equals the number of successful occurrences, no duplicate deduction, and **every** FIRED becomes RECONCILED.

**PASS requires** per-occurrence fire times and per-occurrence single deduction with `logs == successful occurrences`.
**2026-09-18 attempt:** NOT EXECUTED — blocked at runtime provisioning.

### Scenario 5 — Reboot recovery

1. Schedule a future exact occurrence; confirm it exists (`listScheduledOccurrences` / logs).
2. Reboot the device/emulator: `adb reboot`.
3. After boot, verify the future occurrence was restored (`DrugTrackerAlarmSystemReceiver` logs on `BOOT_COMPLETED`, then `restoreFutureSchedules` result via `listScheduledOccurrences`).
4. **Wait for the actual fire** — a restored schedule alone is **not** success — then verify FIRED → reconciliation → single deduction → single log → RECONCILED.

**PASS requires** an observed fire **after** reboot reaching RECONCILED.
**2026-09-18 attempt:** NOT EXECUTED — blocked at runtime provisioning.

### Scenario 6 — Exact-alarm permission recovery

1. With a future exact occurrence scheduled, revoke exact-alarm access (Settings → Apps → Drug Tracker → Alarms & reminders, or `adb shell appops set app.drugtracker SCHEDULE_EXACT_ALARM deny`).
2. Observe current app behavior on schedule/restore paths (`canScheduleExactAlarms()` gate — record what the app actually does; do not change the permission architecture).
3. Re-grant the permission; trigger restore/reschedule; verify the future occurrence is re-installed.
4. Wait for the occurrence to fire and verify the full chain to RECONCILED.

**PASS requires** observed post-recovery fire reaching RECONCILED, plus a factual record of the deny-state behavior.
**2026-09-18 attempt:** NOT EXECUTED — blocked at runtime provisioning.

### Scenario 7 — Duplicate FIRED delivery

Use the project's existing duplicate-delivery protection (occurrence identity + `insertFiredIfAbsent` idempotency + durable stock-gate `already_applied` path). Deliver the **same occurrence** twice — e.g. re-deliver the fire broadcast with the same occurrence extras (`adb shell am broadcast -a app.drugtracker.action.AUTO_DEDUCTION_FIRED …` with the same `medicationId`/`doseId`/`calendarDate`/ownership extras) or re-arm the same alarm — without any production test hook.

Verify: same occurrence identity, stock deducted **once**, `exact-auto:` log **not** duplicated, final reconciliation state correct (FIRED → RECONCILED once; duplicate delivery surfaces as idempotent no-op).

**PASS requires** all three no-duplication observations.
**2026-09-18 attempt:** NOT EXECUTED — blocked at runtime provisioning.

## Findings from this attempt

- **No runtime findings.** No production code was executed on an Android runtime during this attempt, so no runtime failure could be observed and no production change was made.
- Architecture, AlarmManager contracts, EventStore, FIRED/RECONCILED lifecycle, reconciliation logic, stock mutation, Take/Restore, Global Auto, reminder scheduler, and occurrence identity are untouched by this record.
- The environment blocker itself (no KVM/CPU virtualization, no device, no binder) is recorded above with real command outputs and is the sole reason scenarios 1–7 have no results.

## Record for every formal run

| Field | Value |
| ----- | ----- |
| Date | |
| Device / emulator | |
| Android version / API | |
| App build (git SHA / APK path) | |
| Clean install? (`uninstall` / `pm clear`) | |
| Notification / exact-alarm permissions | |
| Scenario | |
| Scheduled time (device clock) | |
| Actual fire time (device clock) | |
| FIRED persisted? | |
| Stock deducted (amount, times) | |
| Exact log count | |
| FIRED → RECONCILED? | |
| Result (PASS / FAIL + details) | |

## Honesty rule

- A PASS requires observing **every** step of a scenario on a real Android runtime; a single missing observation means NOT PASSED.
- "Could not test" is **never** converted to PASS; blocked scenarios stay BLOCKED with the reason.
- Compilation / Gradle success / unit tests are never cited as runtime proof.
- Any real runtime failure is recorded as a separate finding (exact file/class/method + observed behavior) and must not be worked around by production changes inside the validation task.
