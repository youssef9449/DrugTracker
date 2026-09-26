package app.drugtracker.alarmruntime;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import app.drugtracker.dosereminder.DoseReminderAlarmAdapter;

/**
 * Shared-lifecycle adapter for Dose Reminder.
 *
 * <p>The adapter restores durable Dose Reminder exact alarms without making
 * React or Capacitor Local Notifications the source of timing truth.</p>
 */
public final class DoseReminderAlarmFeature
        implements ExactAlarmFeatureAdapter {

    private static final String TAG = "DoseReminderAlarmFeature";

    /**
     * Recovery delay (ms) for a stale snooze found during restore: re-armed
     * slightly in the future so delivery runs with fresh state instead of
     * firing instantly mid-recovery (#513 named constants).
     */
    private static final long SNOOZE_RECOVERY_DELAY_MS = 1_000L;

    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        if (!exactAlarmPermissionGranted) {
            return;
        }

        DoseReminderAlarmAdapter adapter =
                new DoseReminderAlarmAdapter(context);
        for (String key : adapter.listScheduledKeys()) {
            // #506: shared restoration policy — every record reaches a
            // terminal state (restore / resolve / remove / preserve).
            String[] parts = key.split("::", 2);
            boolean identityKeyValid =
                    parts.length == 2 && !parts[0].isEmpty() && !parts[1].isEmpty();

            String medicationId = identityKeyValid ? parts[0] : null;
            String doseId = identityKeyValid ? parts[1] : null;
            JSONObject meta = identityKeyValid
                    ? adapter.getScheduleMetadata(medicationId, doseId)
                    : null;
            boolean cancelled = identityKeyValid && adapter.isOccurrenceEffectivelyCancelled(
                    medicationId,
                    doseId);

            String reminderTime = meta == null ? "" : meta.optString("reminderTime", "");
            String treatmentEndDate = meta == null ? "" : meta.optString("treatmentEndDate", "");
            double amount = meta == null ? 0d : meta.optDouble("amount", 0d);
            String calendarDate = meta == null ? "" : meta.optString("calendarDate", "");
            long triggerFromRecord = reminderTime.isEmpty() || calendarDate.isEmpty()
                    ? -1L
                    : ExactAlarmContract.resolveLocalDateTimeEpochMs(calendarDate, reminderTime, false);
            long now = System.currentTimeMillis();
            boolean triggerInPast = triggerFromRecord > 0L && triggerFromRecord <= now;
            boolean treatmentEndInvalid = !treatmentEndDate.isEmpty()
                    && !ExactAlarmContract.isValidCalendarDate(treatmentEndDate);

            String missingField = null;
            if (reminderTime.isEmpty()) missingField = "reminderTime";
            else if (amount <= 0d) missingField = "amount";
            else if (calendarDate.isEmpty()) missingField = "calendarDate";
            else if (meta == null || meta.optString("unit", "").isEmpty()) missingField = "unit";
            else if (treatmentEndInvalid) missingField = "treatmentEndDate";

            ExactAlarmRestorePolicy.Outcome outcome = ExactAlarmRestorePolicy.evaluate(
                    cancelled,
                    identityKeyValid,
                    meta != null,
                    missingField,
                    triggerFromRecord > 0L,
                    triggerInPast,
                    /* ownershipConflict */ false);

            if (outcome.action == ExactAlarmRestorePolicy.Action.PRESERVE) {
                continue;
            }
            if (outcome.action == ExactAlarmRestorePolicy.Action.REMOVE_MALFORMED) {
                // Terminal cleanup: the record cannot be restored, so remove it
                // through the feature cancel path over the shared runtime.
                if (identityKeyValid) {
                    DoseReminderAlarmAdapter.CancelResult removed =
                            adapter.cancelOccurrence(medicationId, doseId);
                    Log.w(TAG, reason + ": removed malformed alarm record "
                            + key + " (" + outcome.reason + ", removed=" + removed.isOk() + ")");
                } else {
                    Log.w(TAG, reason + ": malformed alarm record key retained for diagnosis: "
                            + key + " (" + outcome.reason + ")");
                }
                continue;
            }
            medicationId = parts[0];
            doseId = parts[1];
            String medicationName = meta.optString(
                    "medicationName", "");
            String unit = meta.optString("unit", "");
            String doseDescription = meta.optString("doseDescription", "");
            boolean allowManualTakeAction = meta.optBoolean(
                    "allowManualTakeAction", true);
            String operationVersion = meta.optString(
                    ExactAlarmContract.FIELD_OPERATION_VERSION,
                    "");

            long trigger = triggerFromRecord;
            if (outcome.action == ExactAlarmRestorePolicy.Action.RESOLVE_STALE) {
                trigger = advanceOneCalendarDay(
                        calendarDate,
                        reminderTime,
                        now);
            }
            if (trigger <= now) {
                Log.w(TAG, reason + ": unrecoverable alarm record removed: "
                        + key + " (no future occurrence)");
                DoseReminderAlarmAdapter.CancelResult removed =
                        adapter.cancelOccurrence(medicationId, doseId);
                Log.w(TAG, reason + ": removal ok=" + removed.isOk());
                continue;
            }
            if (!treatmentEndDate.isEmpty()) {
                java.util.Calendar triggerCalendar =
                        java.util.Calendar.getInstance();
                triggerCalendar.setTimeInMillis(trigger);
                String triggerCalendarDate = String.format(
                        java.util.Locale.US,
                        "%04d-%02d-%02d",
                        triggerCalendar.get(java.util.Calendar.YEAR),
                        triggerCalendar.get(java.util.Calendar.MONTH) + 1,
                        triggerCalendar.get(java.util.Calendar.DAY_OF_MONTH));
                if (triggerCalendarDate.compareTo(treatmentEndDate) > 0) {
                    DoseReminderAlarmAdapter.CancelResult cancel =
                            adapter.cancelOccurrence(medicationId, doseId);
                    if (!cancel.isOk()) {
                        Log.w(TAG, reason + ": failed to cancel expired " + key
                                + " (" + cancel.error + ")");
                    }
                    continue;
                }
            }

            DoseReminderAlarmAdapter.ScheduleResult result =
                    adapter.scheduleOccurrence(
                            medicationId,
                            doseId,
                            reminderTime,
                            amount,
                            medicationName,
                            unit,
                            doseDescription,
                            allowManualTakeAction,
                            trigger,
                            operationVersion.isEmpty()
                                    ? null
                                    : operationVersion,
                            treatmentEndDate.isEmpty() ? null : treatmentEndDate);
            if (!result.ok) {
                Log.w(
                        TAG,
                        reason
                                + ": failed to restore "
                                + key
                                + " ("
                                + result.error
                                + ")");
            }
        }

        restoreSnoozes(
                context,
                reason,
                exactAlarmPermissionGranted);
    }

    private void restoreSnoozes(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        if (!exactAlarmPermissionGranted) return;

        DoseReminderAlarmAdapter adapter =
                new DoseReminderAlarmAdapter(context);
        for (String key : adapter.listScheduledSnoozeKeys()) {
            String[] parts = key.split("::", 2);
            if (parts.length != 2
                    || parts[0].isEmpty()
                    || parts[1].isEmpty()) {
                continue;
            }

            String medicationId = parts[0];
            String doseId = parts[1];
            JSONObject meta =
                    adapter.getSnoozeMetadata(medicationId, doseId);
            if (meta == null
                    || adapter.isSnoozeEffectivelyCancelled(
                            medicationId,
                            doseId)) {
                continue;
            }

            String operationVersion = meta.optString(
                    ExactAlarmContract.FIELD_OPERATION_VERSION,
                    "");
            if (operationVersion.isEmpty()) continue;

            double amount = meta.optDouble("amount", 0d);
            long triggerAt = meta.optLong(
                    ExactAlarmContract.FIELD_TRIGGER_AT_EPOCH_MS,
                    -1L);
            if (amount <= 0d || triggerAt <= 0L) continue;

            long now = System.currentTimeMillis();
            if (triggerAt <= now) {
                triggerAt = now + SNOOZE_RECOVERY_DELAY_MS;
            }

            DoseReminderAlarmAdapter.ScheduleResult result =
                    adapter.scheduleSnooze(
                            medicationId,
                            doseId,
                            meta.optString("reminderTime", ""),
                            amount,
                            meta.optString("medicationName", ""),
                            meta.optString("unit", ""),
                            triggerAt,
                            meta.optBoolean(
                                    "allowManualTakeAction",
                                    true),
                            meta.optString("doseDescription", ""),
                            operationVersion);
            if (!result.ok) {
                Log.w(
                        TAG,
                        reason
                                + ": failed to restore snooze "
                                + key
                                + " ("
                                + result.error
                                + ")");
            }
        }
    }

    private static long advanceOneCalendarDay(
            String calendarDate,
            String reminderTime,
            long now) {
        long trigger = ExactAlarmContract.resolveLocalDateTimeEpochMs(calendarDate, reminderTime, false);
        if (trigger <= 0L) {
            return -1L;
        }
        java.util.Calendar cal =
                java.util.Calendar.getInstance();
        cal.setTimeInMillis(trigger);
        do {
            cal.add(
                    java.util.Calendar.DAY_OF_MONTH,
                    1);
            trigger = cal.getTimeInMillis();
        } while (trigger <= now);
        return trigger;
    }
}
