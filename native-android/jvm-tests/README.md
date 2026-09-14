# Phase 2 auto-deduction JVM unit tests

These tests execute the **real** Java sources under `native-android/auto-deduction/`
(via a Gradle sync-copy into the module build directory at compile time). They use
**Robolectric** so `Context` / `SharedPreferences` / `AlarmManager` APIs are available
on the JVM without a device or emulator.

Production sources are taken from the live repository tree (`../auto-deduction`),
not from checked-in duplicates inside this module. `AutoDeductionPlugin` (Capacitor
bridge) is excluded.

## What is covered

- `AutoDeductionContract` identity and validation
- `AutoDeductionScheduler.nextCalendarDate`
- Effective cancellation / tombstones (`isOccurrenceCancelled` + durable prefs)
- `scheduleNextOccurrenceIfAbsent` (#220 cancelled-successor non-resurrection)
- `AutoDeductionEventStore.insertFiredIfAbsent`
- Deterministic fire-vs-cancel durable outcomes (cancel-first / fire-first)
- Snapshot ownership helpers used by past-recovery (#219)

## Concurrency limitation

Deterministic linearization **outcomes** are tested (cancel-before-fire and
fire-before-cancel via sequential public API calls). **True concurrent**
`SCHEDULE_LOCK` interleavings are **not** tested: production has no test
barriers, and `Thread.sleep`-based races would be flaky.

## Robolectric vs real Android device

Robolectric exercises native code paths that call Android framework classes, but
this harness does **not** validate real-device behavior:

- OEM `AlarmManager` scheduling quirks
- Doze / battery optimizations
- exact-alarm permission grants on a physical device
- boot / quick-boot restore on a physical device

Do not treat a green `./gradlew test` as device or OEM validation.

## Run

Requires JDK 17+ and network access to resolve Maven dependencies on first run.

```bash
cd native-android/jvm-tests
./gradlew test
```

If the Gradle wrapper is missing, generate it with a local Gradle install:

```bash
gradle wrapper --gradle-version 8.7
./gradlew test
```
