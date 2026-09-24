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
import java.util.List;
import java.util.Map;
/**
 * Capacitor bridge for Exact Auto scheduling, Native stock execution, and
 * JavaScript/UI convergence.
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
        String treatmentEndDate = call.getString("treatmentEndDate", "");
        if (amountObj == null) {
            call.reject("invalid_amount");
            return;
        }
        double amount = amountObj;
        long epoch = scheduledAt != null ? scheduledAt : 0L;
        app.drugtracker.alarmruntime.ExactAlarmRuntime.executeAsync(() -> {
            try {
                AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
                AutoDeductionScheduler.ScheduleResult result = scheduler.scheduleOccurrence(
                        medicationId,
                        doseId,
                        calendarDate,
                        timeHhmm,
                        amount,
                        epoch,
                        treatmentEndDate);
                JSObject ret = new JSObject();
                ret.put("ok", result.ok);
                if (result.error != null) ret.put("error", result.error);
                if (result.occurrenceKey != null) ret.put("occurrenceKey", result.occurrenceKey);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "scheduleOccurrence failed", e);
                call.reject(e.getMessage() != null ? e.getMessage() : "schedule_occurrence_failed");
            }
        });
    }
    @PluginMethod
    public void cancelOccurrence(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        app.drugtracker.alarmruntime.ExactAlarmRuntime.executeAsync(() -> {
            try {
                AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
                AutoDeductionScheduler.CancelResult result = scheduler.cancelOccurrence(
                        medicationId, doseId, calendarDate);
                JSObject ret = new JSObject();
                ret.put("ok", result.isOk());
                ret.put("status", result.status.name());
                if (result.error != null) ret.put("error", result.error);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "cancelOccurrence failed", e);
                call.reject(e.getMessage() != null ? e.getMessage() : "cancel_occurrence_failed");
            }
        });
    }
    @PluginMethod
    public void recoverMissedOccurrence(PluginCall call) {
        recoverMissedOccurrenceInternal(call, false);
    }

    @PluginMethod
    public void recoverMissedOccurrenceForCompensation(PluginCall call) {
        recoverMissedOccurrenceInternal(call, true);
    }

    private void recoverMissedOccurrenceInternal(
            PluginCall call,
            boolean compensation) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        Double amountObj = call.getDouble("amount");
        Long scheduledAtObj = call.getLong("scheduledAtEpochMs");
        Long generationObj = call.getLong("expectedRecurrenceGeneration");
        double amount = amountObj != null ? amountObj : Double.NaN;
        long scheduledAt = scheduledAtObj != null ? scheduledAtObj : -1L;
        long generation = generationObj != null ? generationObj : 0L;
        app.drugtracker.alarmruntime.ExactAlarmRuntime.executeAsync(() -> {
            try {
                AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
                AutoDeductionScheduler.FireResult result = compensation
                        ? scheduler.recoverMissedOccurrenceForCompensation(
                                medicationId, doseId, calendarDate,
                                scheduledAt, amount, generation)
                        : scheduler.recoverMissedOccurrence(
                                medicationId, doseId, calendarDate,
                                scheduledAt, amount, generation);
                JSObject ret = new JSObject();
                ret.put("ok", result.allowsRecurrence());
                ret.put("status", result.status.name());
                if (result.status != AutoDeductionScheduler.FireResult.Status.CANCELLED
                        && result.status != AutoDeductionScheduler.FireResult.Status.CREATED
                        && result.status != AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS) {
                    ret.put("ok", false);
                }
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "recoverMissedOccurrence failed", e);
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("status", "FAILED");
                ret.put("error", e.getMessage() != null ? e.getMessage() : "recovery_failed");

                ret.put("code", "recovery_failed");
                call.resolve(ret);
            }
        });
    }

    /**
     * medication+dose recurrence disable — bumps durable generation under
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
        app.drugtracker.alarmruntime.ExactAlarmRuntime.executeAsync(() -> {
            try {
                AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
                AutoDeductionScheduler.InvalidateResult result =
                        scheduler.invalidateRecurrenceAuthorization(medicationId, doseId);
                JSObject ret = new JSObject();
                ret.put("ok", result.ok);
                if (result.error != null) ret.put("error", result.error);
                if (result.ok || result.schedulesCancelled) {
                    ret.put("generation", result.generation);
                }
                ret.put("schedulesCancelled", result.schedulesCancelled);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "invalidateRecurrenceAuthorization failed", e);
                call.reject(e.getMessage() != null ? e.getMessage() : "invalidate_recurrence_failed");
            }
        });
    }
    @PluginMethod
    public void listFiredEvents(PluginCall call) {
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        AutoDeductionEventStore.FiredEventsResult result = store.listFiredEventsResult();
        JSArray arr = new JSArray();
        for (AutoDeductionPersistenceModels.EventRecord record : result.records) {
            try {
                arr.put(toJSObject(AutoDeductionPersistenceCodec.encodeEvent(record)));
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

    @PluginMethod
    public void markReconciled(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        AutoDeductionEventStore.MarkResult result = store.markReconciled(medicationId, doseId, calendarDate);
        new AutoDeductionScheduler(getContext()).compactTerminalState();
        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        ret.put("changed", result.changed);
        call.resolve(ret);
    }
    @PluginMethod
    public void restoreFutureSchedules(PluginCall call) {
        app.drugtracker.alarmruntime.ExactAlarmRuntime.executeAsync(() -> {
            try {
                AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
                AutoDeductionScheduler.RestoreResult result = scheduler.restoreFutureSchedules();
                JSObject ret = new JSObject();
                ret.put("ok", result.ok);
                ret.put("restored", result.restored);
                ret.put("failed", result.failed);
                if (result.error != null) {
                    ret.put("error", result.error);
                    ret.put("code", result.error);
                }
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "restoreFutureSchedules failed", e);
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("restored", 0);
                ret.put("failed", 0);
                ret.put("error", e.getMessage() != null ? e.getMessage() : "restore_failed");

                ret.put("code", "restore_failed");
                call.resolve(ret);
            }
        });
    }
    /**
     * List durable schedule metadata so JS can cancel stale occurrences
     * after process restart (trackedRef is empty).
     */
    @PluginMethod
    public void listScheduledOccurrences(PluginCall call) {
        try {
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
            java.util.List<AutoDeductionPersistenceModels.ScheduledOccurrenceRecord> rows =
                    scheduler.listScheduledOccurrences();
            JSArray arr = new JSArray();
            for (AutoDeductionPersistenceModels.ScheduledOccurrenceRecord row : rows) {
                AutoDeductionPersistenceModels.ScheduleRecord o = row.schedule;
                JSObject js = new JSObject();
                js.put("medicationId", o.occurrence.medicationId);
                js.put("doseId", o.occurrence.doseId);
                js.put("calendarDate", o.occurrence.calendarDate);
                js.put("timeHhmm", o.timeHhmm);
                js.put("amount", o.amount);
                js.put("scheduledAtEpochMs", o.scheduledAtEpochMs);
                if (row.fireRetryCount > 0) {
                    js.put("fireRetryCount", row.fireRetryCount);
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
     * Initialize Native stock for the currently persisted JS medications.
     * Existing Native balances are authoritative; only missing rows are seeded
     * from JS. The returned balances are the values JS must mirror into
     * Medication.currentPills.
     */
    @PluginMethod
    public void initializeStock(PluginCall call) {
        JSArray medications = call.getArray("medications");
        List<AutoDeductionStockStore.StockSeed> seeds =
                new ArrayList<AutoDeductionStockStore.StockSeed>();
        try {
            if (medications != null) {
                for (int i = 0; i < medications.length(); i++) {
                    JSONObject obj = medications.optJSONObject(i);
                    if (obj == null) continue;
                    String medicationId = obj.optString("medicationId", "").trim();
                    double currentPills = obj.optDouble("currentPills", Double.NaN);
                    if (medicationId.isEmpty()
                            || !Double.isFinite(currentPills)
                            || currentPills < 0.0) {
                        continue;
                    }
                    seeds.add(new AutoDeductionStockStore.StockSeed(
                            medicationId, currentPills));
                }
            }
            AutoDeductionStockStore.SnapshotResult result =
                    new AutoDeductionStockStore(getContext()).ensureMissingAndRead(seeds);
            JSObject ret = new JSObject();
            ret.put("ok", result.ok);
            JSArray stocks = new JSArray();
            for (Map.Entry<String, Double> entry : result.stocks.entrySet()) {
                JSObject stock = new JSObject();
                stock.put("medicationId", entry.getKey());
                stock.put("currentPills", entry.getValue());
                stocks.put(stock);
            }
            ret.put("stocks", stocks);
            if (result.error != null) ret.put("error", result.error);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "initializeStock failed", e);
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("stocks", new JSArray());
            ret.put("error", e.getMessage() != null
                    ? e.getMessage()
                    : "stock_init_failed");
            call.resolve(ret);
        }
    }
    /**
     * Apply foreground signed stock deltas idempotently by mutationSeq.
     * Manual/Refill/Restore JS mutations use this path after computing their
     * result from a Native-converged durable snapshot.
     */
    @PluginMethod
    public void applyForegroundStockDeltas(PluginCall call) {
        Long mutationSeqObj = call.getLong("mutationSeq");
        long mutationSeq = mutationSeqObj != null ? mutationSeqObj : 0L;
        JSArray rawDeltas = call.getArray("deltas");
        List<AutoDeductionStockStore.StockDelta> deltas =
                new ArrayList<AutoDeductionStockStore.StockDelta>();
        try {
            if (rawDeltas != null) {
                for (int i = 0; i < rawDeltas.length(); i++) {
                    JSONObject obj = rawDeltas.optJSONObject(i);
                    if (obj == null) continue;
                    deltas.add(new AutoDeductionStockStore.StockDelta(
                            obj.optString("medicationId", "").trim(),
                            obj.optDouble("delta", Double.NaN)));
                }
            }
            List<AutoDeductionStockStore.OccurrenceResolution> resolutions =
                    new ArrayList<AutoDeductionStockStore.OccurrenceResolution>();
            JSArray rawResolutions = call.getArray("occurrenceResolutions");
            if (rawResolutions != null) {
                for (int i = 0; i < rawResolutions.length(); i++) {
                    JSONObject obj = rawResolutions.optJSONObject(i);
                    if (obj == null) continue;
                    String type = obj.optString("type", "").trim().toUpperCase();
                    AutoDeductionStockStore.OccurrenceResolution.Type resolutionType;
                    try {
                        resolutionType =
                                AutoDeductionStockStore.OccurrenceResolution.Type.valueOf(type);
                    } catch (IllegalArgumentException e) {
                        JSObject ret = new JSObject();
                        ret.put("ok", false);
                        ret.put("alreadyApplied", false);
                        ret.put("stocks", new JSArray());
                        ret.put("error", "invalid_occurrence_resolution");
                        call.resolve(ret);
                        return;
                    }
                    resolutions.add(new AutoDeductionStockStore.OccurrenceResolution(
                            obj.optString("medicationId", "").trim(),
                            obj.optString("doseId", "").trim(),
                            obj.optString("calendarDate", ""),
                            resolutionType));
                }
            }
            AutoDeductionStockStore.ForegroundApplyResult result =
                    new AutoDeductionStockStore(getContext()).applyForegroundDeltas(
                            mutationSeq, deltas, resolutions);
            new AutoDeductionScheduler(getContext()).compactTerminalState();
            JSObject ret = new JSObject();
            ret.put("ok", result.ok);
            ret.put("alreadyApplied", result.alreadyApplied);
            JSArray stocks = new JSArray();
            for (Map.Entry<String, Double> entry : result.stocks.entrySet()) {
                JSObject stock = new JSObject();
                stock.put("medicationId", entry.getKey());
                stock.put("currentPills", entry.getValue());
                stocks.put(stock);
            }
            ret.put("stocks", stocks);
            if (result.error != null) ret.put("error", result.error);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "applyForegroundStockDeltas failed", e);
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("alreadyApplied", false);
            ret.put("error", e.getMessage() != null
                    ? e.getMessage()
                    : "foreground_stock_failed");
            call.resolve(ret);
        }
    }
    /**
     * Repair/apply one exact Auto occurrence on the Native stock authority.
     * The operation is occurrence-idempotent.
     */
    @PluginMethod
    public void applyAutoDeductionStock(PluginCall call) {
        resolveAutoDeductionStock(call, false);
    }

    /**
     * Explicit recovery path for reconciliation of durable FIRED evidence.
     * Historical dates are allowed only through this authorized path.
     */
    @PluginMethod
    public void recoverAutoDeductionStock(PluginCall call) {
        resolveAutoDeductionStock(call, true);
    }

    private void resolveAutoDeductionStock(PluginCall call, boolean recovery) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        Double amountObj = call.getDouble("amount");
        double amount = amountObj != null ? amountObj : Double.NaN;
        AutoDeductionStockStore store = new AutoDeductionStockStore(getContext());
        AutoDeductionStockStore.AutoApplyResult result =
                recovery
                        ? store.applyAutoDeductionForRecovery(
                                medicationId, doseId, calendarDate, amount)
                        : store.applyAutoDeduction(
                                medicationId, doseId, calendarDate, amount);
        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        ret.put("applied", result.applied);
        ret.put("actualDeducted", result.actualDeducted);
        ret.put("currentPills", result.currentPills);
        if (result.error != null) ret.put("error", result.error);
        call.resolve(ret);
    }
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
        if (!o.isNull("reconciledAtEpochMs")) {
            js.put("reconciledAtEpochMs", o.optLong("reconciledAtEpochMs", 0L));
        } else {
            js.put("reconciledAtEpochMs", (Object) null);
        }
        return js;
    }
}