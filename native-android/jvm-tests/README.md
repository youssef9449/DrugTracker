# Phase 2 auto-deduction JVM unit tests

These tests execute the **real** Java sources under `native-android/auto-deduction/`
(via a Gradle sync copy into the module classpath). They use **Robolectric** so
`Context` / `SharedPreferences` / `AlarmManager` APIs run on the JVM without a
device or emulator.

## What is covered

- `AutoDeductionContract` identity and validation
- `AutoDeductionScheduler.nextCalendarDate`
- Effective cancellation / tombstones (`isOccurrenceCancelled` / prefs state)
- `scheduleNextOccurrenceIfAbsent` (#220 cancelled-successor non-resurrection)
- `AutoDeductionEventStore.insertFiredIfAbsent`
- Deterministic fire-vs-cancel outcomes via public scheduler APIs

## What is not covered here

- Capacitor `AutoDeductionPlugin` bridge (requires Capacitor)
- True multi-threaded interleaving races (no production test barriers)
- Full boot / timezone restore integration on a device

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
