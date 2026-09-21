package app.drugtracker.autodeduction;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Capacitor bridge for Auto scheduling, FIRED recovery, and native background
 * stock execution. JS reconciliation still owns localStorage convergence and logs.
 */
@CapacitorPlugin(name = "AutoDeduction")
public class AutoDeductionPlugin extends Plugin {

    private static final String TAG = "AutoDeductionPlugin";

    private BroadcastReceiver exactAutoFiredReceiver;

    @Override
    public void load() {
        super.load();

        exactAutoFiredReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!AutoDeductionContract.ACTION_AUTO_DEDUCTION_FIRED.equals(intent.getAction())) {
                    return;
                }

                JSObject event = new JSObject();
                event.put("medicationId", intent.getStringExtra(
                        AutoDeductionContract.EXTRA_MEDICATION_ID));
                event.put("doseId", intent.getStringExtra(
                        AutoDeductionContract.EXTRA_DOSE_ID));
                event.put("calendarDate", intent.getStringExtra(
                        AutoDeductionContract.EXTRA_CALENDAR_DATE));
                event.put("scheduledAtEpochMs", intent.getLongExtra(
                        AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS, 0L));
                event.put("amount", intent.getDoubleExtra(
                        AutoDeductionContract.EXTRA_AMOUNT, Double.NaN));
                if (intent.hasExtra("backgroundStockApplied")) {
                    event.put("backgroundStockApplied", intent.getBooleanExtra(
                            "backgroundStockApplied", false));
                    event.put("backgroundCurrentPills", intent.getDoubleExtra(
                            "backgroundCurrentPills", Double.NaN));
                    event.put("backgroundDeductedAmount", intent.getDoubleExtra(
                            "backgroundDeductedAmount", 0.0d));
                    event.put("backgroundStockVersion", intent.getLongExtra(
                            "backgroundStockVersion", 0L));
                }

                notifyListeners("exactAutoDeductionFired", event);
            }
        };

        IntentFilter filter = new IntentFilter(
                AutoDeductionContract.ACTION_AUTO_DEDUCTION_FIRED);
        ContextCompat.registerReceiver(
                getContext(),
                exactAutoFiredReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        if (exactAutoFiredReceiver != null) {
            try {
                getContext().unregisterReceiver(exactAutoFiredReceiver);
            } catch (IllegalArgumentException ignored) {
                // Receiver was already unregistered during teardown.
            }
            exactAutoFiredReceiver = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void scheduleOccurrence(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        String timeHhmm = call.getString("timeHhmm");
        Double amountObj = call.getDouble("amount");
        Long scheduledAt = call.getLong("scheduledAtEpochMs");

        if (amountObj == null) {
            call.reject("invalid_amount");
            return;
        }
        double amount = amountObj;
        long epoch = scheduledAt != null ? scheduledAt : 0L;

        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        AutoDeductionScheduler.ScheduleResult result = scheduler.scheduleOccurrence(
                medicationId, doseId, calendarDate, timeHhmm, amount, epoch);

        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        if (result.error != null) ret.put("error", result.error);
        if (result.occurrenceKey != null) ret.put("occurrenceKey", result.occurrenceKey);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelOccurrence(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        AutoDeductionScheduler.CancelResult result = scheduler.cancelOccurrence(
                medicationId, doseId, calendarDate);
        JSObject ret = new JSObject();
        ret.put("ok", result.isOk());
        ret.put("status", result.status.name());
        if (result.error != null) ret.put("error", result.error);
        call.resolve(ret);
    }

    /**
     * Issue #217: medication+dose recurrence disable — bumps durable generation under
     * SCHEDULE_LOCK and cancels all future scheduled occurrences for that dose slot.
     */
    @PluginMethod
    public void invalidateRecurrenceAuthorization(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()) {
            call.reject("invalid_args");
            return;
        }
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        AutoDeductionScheduler.InvalidateResult result =
                scheduler.invalidateRecurrenceAuthorization(medicationId, doseId);
        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        if (result.error != null) ret.put("error", result.error);
        if (result.ok) ret.put("generation", result.generation);
        call.resolve(ret);
    }

    @PluginMethod
    public void listFiredEvents(PluginCall call) {
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        AutoDeductionEventStore.FiredEventsResult result = store.listFiredEventsResult();
        JSArray arr = new JSArray();
        BackgroundStockStore backgroundStore = new BackgroundStockStore(getContext());
        for (JSONObject o : result.events) {
            try {
                String medicationId = o.optString("medicationId", "");
                String doseId = o.optString("doseId", "");
                String calendarDate = o.optString("calendarDate", "");
                BackgroundStockStore.OccurrenceSnapshot background =
                        backgroundStore.getOccurrenceSnapshot(
                                medicationId, doseId, calendarDate);
                // listFiredEvents is a read boundary. It only exposes the already
                // repaired native execution result; it never applies stock.
                if (background.nativeAuto) {
                    o.put("backgroundStockApplied", true);
                    o.put("backgroundCurrentPills", background.currentPills);
                    o.put("backgroundDeductedAmount", background.deductedAmount);
                    o.put("backgroundStockVersion", backgroundStore.getVersion());
                }
                arr.put(toJSObject(o));
            } catch (Exception e) {
                Log.w(TAG, "skip event", e);
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        ret.put("events", arr);
        if (result.error != null) ret.put("error", result.error);
        call.resolve(ret);
    }

    /**
     * Repair boundary for FIRED events that may have been persisted immediately
     * before a process death interrupted native background stock application.
     * This method mutates only the Auto background execution ledger and never
     * acknowledges/marks FIRED rows as reconciled.
     */
    @PluginMethod
    public void repairBackgroundStockFromFiredEvents(PluginCall call) {
        try {
            AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
            AutoDeductionEventStore.FiredEventsResult result =
                    store.listFiredEventsResult();
            if (!result.ok) {
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("repaired", 0);
                ret.put("error", result.error != null
                        ? result.error
                        : "fired_list_failed");
                call.resolve(ret);
                return;
            }

            int repaired = 0;
            BackgroundStockStore backgroundStore = new BackgroundStockStore(getContext());

            // Apply FIRED occurrences in the same deterministic order used by JS
            // reconciliation so insufficient stock is attributed identically on both sides.
            List<JSONObject> orderedEvents = new ArrayList<>(result.events);
            Collections.sort(orderedEvents, (a, b) -> {
                long ta = a.optLong("scheduledAtEpochMs", 0L);
                long tb = b.optLong("scheduledAtEpochMs", 0L);
                if (ta != tb) return Long.compare(ta, tb);
                String ka = AutoDeductionContract.occurrenceKey(
                        a.optString("medicationId", ""),
                        a.optString("doseId", ""),
                        a.optString("calendarDate", ""));
                String kb = AutoDeductionContract.occurrenceKey(
                        b.optString("medicationId", ""),
                        b.optString("doseId", ""),
                        b.optString("calendarDate", ""));
                return ka.compareTo(kb);
            });

            for (JSONObject o : orderedEvents) {
                String medicationId = o.optString("medicationId", "");
                String doseId = o.optString("doseId", "");
                String calendarDate = o.optString("calendarDate", "");
                double amount = o.optDouble("amount", Double.NaN);
                BackgroundStockStore.ApplyResult applied =
                        backgroundStore.applyEventIfNeeded(
                                medicationId,
                                doseId,
                                calendarDate,
                                amount);
                if (!applied.ok) {
                    // A FIRED event for a medication that no longer exists is
                    // intentionally resolved by JS as skipped-missing-med and
                    // must not block the whole background-repair boundary.
                    if ("missing_medication".equals(applied.error)) {
                        continue;
                    }
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("repaired", repaired);
                    ret.put("error", applied.error != null
                            ? applied.error
                            : "background_stock_apply_failed");
                    call.resolve(ret);
                    return;
                }
                if (applied.changed) {
                    repaired++;
                }
            }

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("repaired", repaired);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "repairBackgroundStockFromFiredEvents failed", e);
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("repaired", 0);
            ret.put("error", e.getMessage() != null
                    ? e.getMessage()
                    : "background_stock_repair_failed");
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void listEvents(PluginCall call) {
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        List<JSONObject> events = store.listEvents();
        JSArray arr = new JSArray();
        for (JSONObject o : events) {
            try {
                arr.put(toJSObject(o));
            } catch (Exception e) {
                Log.w(TAG, "skip event", e);
            }
        }
        JSObject ret = new JSObject();
        ret.put("events", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void markReconciled(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        AutoDeductionEventStore.MarkResult result = store.markReconciled(medicationId, doseId, calendarDate);
        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        ret.put("changed", result.changed);
        call.resolve(ret);
    }

    @PluginMethod
    public void restoreFutureSchedules(PluginCall call) {
        try {
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
            AutoDeductionScheduler.RestoreResult result = scheduler.restoreFutureSchedules();
            JSObject ret = new JSObject();
            ret.put("ok", result.ok);
            ret.put("restored", result.restored);
            ret.put("failed", result.failed);
            if (result.error != null) {
                ret.put("error", result.error);
            }
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "restoreFutureSchedules failed", e);
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("restored", 0);
            ret.put("failed", 0);
            ret.put("error", e.getMessage() != null ? e.getMessage() : "restore_failed");
            call.resolve(ret);
        }
    }

    /**
     * List durable schedule metadata so JS can cancel stale occurrences
     * after process restart (trackedRef is empty).
     */
    @PluginMethod
    public void listScheduledOccurrences(PluginCall call) {
        try {
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
            java.util.List<JSONObject> rows = scheduler.listScheduledOccurrences();
            JSArray arr = new JSArray();
            for (JSONObject o : rows) {
                JSObject js = new JSObject();
                js.put("medicationId", o.optString("medicationId", ""));
                js.put("doseId", o.optString("doseId", ""));
                js.put("calendarDate", o.optString("calendarDate", ""));
                js.put("timeHhmm", o.optString("timeHhmm", ""));
                js.put("amount", o.optDouble("amount", 0));
                js.put("scheduledAtEpochMs", o.optLong("scheduledAtEpochMs", 0L));
                if (o.has("fireRetryCount")) {
                    js.put("fireRetryCount", o.optInt("fireRetryCount", 0));
                }
                arr.put(js);
            }
            JSObject ret = new JSObject();
            ret.put("schedules", arr);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "listScheduledOccurrences failed", e);
            call.reject(e.getMessage() != null
                    ? e.getMessage()
                    : "list_schedules_failed");
        }
    }


    /**
     * Sync the complete JS stock snapshot into Auto's native background
     * execution shadow. The generation-aware store preserves native Auto
     * deductions that raced ahead of this foreground snapshot.
     */
    @PluginMethod
    public void syncBackgroundStock(PluginCall call) {
        try {
            JSArray meds = call.getArray("medications");
            long stockGeneration = call.getLong("stockGeneration", 0L);
            JSArray applied = call.getArray("alreadyAppliedOccurrences");
            JSArray clearApplied = call.getArray("clearAppliedOccurrences");
            JSArray jsManualTake = call.getArray("jsManualTakeOccurrences");
            JSArray jsRestore = call.getArray("jsRestoreOccurrences");

            java.util.List<BackgroundStockStore.MedicationState> rows =
                    new java.util.ArrayList<>();
            if (meds != null) {
                for (int i = 0; i < meds.length(); i++) {
                    JSONObject row = meds.getJSONObject(i);
                    rows.add(new BackgroundStockStore.MedicationState(
                            row.optString("medicationId", ""),
                            row.optDouble("currentPills", 0.0d),
                            stockGeneration));
                }
            }

            java.util.Set<String> already = new java.util.HashSet<>();
            if (applied != null) {
                for (int i = 0; i < applied.length(); i++) {
                    String key = applied.getString(i);
                    if (key != null && !key.isEmpty()) already.add(key);
                }
            }
            java.util.Set<String> clear = new java.util.HashSet<>();
            if (clearApplied != null) {
                for (int i = 0; i < clearApplied.length(); i++) {
                    String key = clearApplied.getString(i);
                    if (key != null && !key.isEmpty()) clear.add(key);
                }
            }
            java.util.Set<String> manualTake = new java.util.HashSet<>();
            if (jsManualTake != null) {
                for (int i = 0; i < jsManualTake.length(); i++) {
                    String key = jsManualTake.getString(i);
                    if (key != null && !key.isEmpty()) manualTake.add(key);
                }
            }
            java.util.Set<String> restore = new java.util.HashSet<>();
            if (jsRestore != null) {
                for (int i = 0; i < jsRestore.length(); i++) {
                    String key = jsRestore.getString(i);
                    if (key != null && !key.isEmpty()) restore.add(key);
                }
            }

            BackgroundStockStore.SyncResult result =
                    new BackgroundStockStore(getContext()).syncFromJs(
                            rows,
                            stockGeneration,
                            already,
                            clear,
                            manualTake,
                            restore);
            JSObject ret = new JSObject();
            ret.put("ok", result.ok);
            ret.put("backgroundVersion", result.backgroundVersion);
            JSObject pills = new JSObject();
            for (java.util.Map.Entry<String, Double> entry :
                    result.currentPillsByMedication.entrySet()) {
                pills.put(entry.getKey(), entry.getValue());
            }
            ret.put("currentPillsByMedication", pills);
            if (result.error != null) ret.put("error", result.error);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "syncBackgroundStock failed", e);
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("backgroundVersion", 0L);
            ret.put("currentPillsByMedication", new JSObject());
            ret.put("error", e.getMessage() != null
                    ? e.getMessage()
                    : "background_stock_sync_failed");
            call.resolve(ret);
        }
    }

    /** Return the complete native background stock execution snapshot. */
    @PluginMethod
    public void getBackgroundStockSnapshot(PluginCall call) {
        try {
            BackgroundStockStore store = new BackgroundStockStore(getContext());
            JSObject pills = new JSObject();
            for (java.util.Map.Entry<String, Double> entry :
                    store.readAllCurrentPills().entrySet()) {
                pills.put(entry.getKey(), entry.getValue());
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("backgroundVersion", store.getVersion());
            ret.put("currentPillsByMedication", pills);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "getBackgroundStockSnapshot failed", e);
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("backgroundVersion", 0L);
            ret.put("currentPillsByMedication", new JSObject());
            ret.put("error", e.getMessage() != null
                    ? e.getMessage()
                    : "background_stock_snapshot_failed");
            call.resolve(ret);
        }
    }

    /**
     * Phase 4 — atomic occurrence snapshot for Manual Take amount authority.
     * Runs under SCHEDULE_LOCK on the native side.
     */
    @PluginMethod
    public void getOccurrenceSnapshot(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || calendarDate == null || calendarDate.isEmpty()) {
            call.reject("missing_params");
            return;
        }
        try {
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
            AutoDeductionScheduler.OccurrenceSnapshot snap =
                    scheduler.getOccurrenceSnapshot(medicationId, doseId, calendarDate);
            JSObject ret = new JSObject();
            ret.put("ok", snap.ok);
            if (!snap.ok) {
                ret.put("error", snap.error != null ? snap.error : "snapshot_failed");
                call.resolve(ret);
                return;
            }
            ret.put("status", snap.status.name());
            if (snap.amount != null) {
                ret.put("amount", snap.amount.doubleValue());
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "snapshot_failed");
        }
    }

    private static JSObject toJSObject(JSONObject o) {
        JSObject js = new JSObject();
        js.put("medicationId", o.optString("medicationId", ""));
        js.put("doseId", o.optString("doseId", ""));
        js.put("calendarDate", o.optString("calendarDate", ""));
        js.put("scheduledAtEpochMs", o.optLong("scheduledAtEpochMs", 0L));
        js.put("amount", o.optDouble("amount", 0));
        js.put("status", o.optString("status", ""));
        js.put("createdAtEpochMs", o.optLong("createdAtEpochMs", 0L));
        if (o.has("backgroundStockApplied")) {
            js.put("backgroundStockApplied", o.optBoolean("backgroundStockApplied", false));
            js.put("backgroundCurrentPills", o.optDouble("backgroundCurrentPills", Double.NaN));
            js.put("backgroundDeductedAmount", o.optDouble("backgroundDeductedAmount", 0.0d));
            js.put("backgroundStockVersion", o.optLong("backgroundStockVersion", 0L));
        }
        if (!o.isNull("reconciledAtEpochMs")) {
            js.put("reconciledAtEpochMs", o.optLong("reconciledAtEpochMs", 0L));
        } else {
            js.put("reconciledAtEpochMs", (Object) null);
        }
        return js;
    }
}
