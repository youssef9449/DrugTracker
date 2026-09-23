package app.drugtracker.autodeduction;

import org.json.JSONException;
import org.json.JSONObject;
import app.drugtracker.alarmruntime.ExactAlarmContract;

/**
 * The only JSON serialization/deserialization boundary for native Auto
 * persistence records.
 */
final class AutoDeductionPersistenceCodec {
    private AutoDeductionPersistenceCodec() {}

    static final class DecodeResult {
        final AutoDeductionPersistenceModels.EventRecord record;
        final String status;
        final String error;

        private DecodeResult(
                AutoDeductionPersistenceModels.EventRecord record,
                String status,
                String error) {
            this.record = record;
            this.status = status;
            this.error = error;
        }

        static DecodeResult success(
                AutoDeductionPersistenceModels.EventRecord record) {
            return new DecodeResult(record, record.status, null);
        }

        static DecodeResult failure(String status, String error) {
            return new DecodeResult(null, status, error);
        }

        boolean isSuccess() {
            return record != null;
        }
    }

    static JSONObject encodeEvent(
            AutoDeductionPersistenceModels.EventRecord record)
            throws JSONException {
        if (record == null
                || record.occurrence == null
                || record.status == null
                || record.status.isEmpty()) {
            throw new JSONException("invalid_event_record");
        }
        JSONObject obj = new JSONObject();
        obj.put("medicationId", record.occurrence.medicationId);
        obj.put("doseId", record.occurrence.doseId);
        obj.put("calendarDate", record.occurrence.calendarDate);
        obj.put("scheduledAtEpochMs", record.scheduledAtEpochMs);
        obj.put("amount", record.amount);
        obj.put("status", record.status);
        obj.put("createdAtEpochMs", record.createdAtEpochMs);
        if (record.reconciledAtEpochMs == null) {
            obj.put("reconciledAtEpochMs", JSONObject.NULL);
        } else {
            obj.put("reconciledAtEpochMs", record.reconciledAtEpochMs);
        }
        if (record.rejectedAtEpochMs != null) {
            obj.put("rejectedAt", record.rejectedAtEpochMs);
        }
        if (record.rejectionReason != null) {
            obj.put("rejectionReason", record.rejectionReason);
        }
        return obj;
    }

    static String encodeEventString(
            AutoDeductionPersistenceModels.EventRecord record)
            throws JSONException {
        return encodeEvent(record).toString();
    }

    static AutoDeductionPersistenceModels.EventRecord fired(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            long createdAtEpochMs)
            throws JSONException {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            throw new JSONException("invalid_event_record");
        }
        return AutoDeductionPersistenceModels.EventRecord.fired(
                new AutoDeductionPersistenceModels.OccurrenceId(
                        medicationId, doseId, calendarDate),
                scheduledAtEpochMs,
                amount,
                createdAtEpochMs);
    }

    static DecodeResult decodeEvent(String raw) {
        if (raw == null || raw.isEmpty()) {
            return DecodeResult.failure("", "missing_event");
        }
        try {
            return decodeEvent(new JSONObject(raw));
        } catch (JSONException e) {
            return DecodeResult.failure("", "invalid_json");
        }
    }

    static DecodeResult decodeEvent(JSONObject obj) {
        if (obj == null) {
            return DecodeResult.failure("", "null_event");
        }

        String status = obj.optString("status", "");
        if (AutoDeductionContract.STATUS_REJECTED.equals(status)) {
            return DecodeResult.failure(status, "terminal_rejected");
        }

        try {
            String medicationId = obj.optString("medicationId", "").trim();
            String doseId = obj.optString("doseId", "").trim();
            String calendarDate = obj.optString("calendarDate", "").trim();
            double amount = obj.optDouble("amount", Double.NaN);
            long scheduledAt = obj.optLong("scheduledAtEpochMs", Long.MIN_VALUE);
            long createdAt = obj.optLong("createdAtEpochMs", Long.MIN_VALUE);

            if (medicationId.isEmpty()
                    || doseId.isEmpty()
                    || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                    || !AutoDeductionContract.isValidAmount(amount)
                    || scheduledAt < 0L
                    || createdAt <= 0L
                    || (!AutoDeductionContract.STATUS_FIRED.equals(status)
                    && !AutoDeductionContract.STATUS_RECONCILED.equals(status))) {
                return DecodeResult.failure(status, "invalid_event_record");
            }

            Long reconciledAt = null;
            if (obj.has("reconciledAtEpochMs")
                    && !obj.isNull("reconciledAtEpochMs")) {
                long value = obj.optLong("reconciledAtEpochMs", Long.MIN_VALUE);
                if (value == Long.MIN_VALUE || value < 0L) {
                    return DecodeResult.failure(status, "invalid_reconciled_timestamp");
                }
                reconciledAt = value;
            }

            return DecodeResult.success(
                    new AutoDeductionPersistenceModels.EventRecord(
                            new AutoDeductionPersistenceModels.OccurrenceId(
                                    medicationId, doseId, calendarDate),
                            scheduledAt,
                            amount,
                            status,
                            createdAt,
                            reconciledAt,
                            null,
                            null));
        } catch (RuntimeException e) {
            return DecodeResult.failure(status, "invalid_event_record");
        }
    }

    static AutoDeductionPersistenceModels.EventRecord fromPending(
            String raw)
            throws JSONException {
        DecodeResult decoded = decodeEvent(raw);
        if (!decoded.isSuccess()) {
            throw new JSONException(
                    decoded.error == null ? "invalid_pending_record" : decoded.error);
        }
        return decoded.record;
    }

    static AutoDeductionPersistenceModels.ScheduleRecord decodeSchedule(
            String raw) throws JSONException {
        if (raw == null || raw.isEmpty()) {
            throw new JSONException("missing_schedule");
        }
        JSONObject obj = new JSONObject(raw);
        String medicationId = obj.optString("medicationId", "").trim();
        String doseId = obj.optString("doseId", "").trim();
        String calendarDate = obj.optString("calendarDate", "").trim();
        String timeHhmm = obj.optString("timeHhmm", "").trim();
        double amount = obj.optDouble("amount", Double.NaN);
        long scheduledAt = obj.optLong("scheduledAtEpochMs", -1L);
        String treatmentEndDate = obj.optString(
                AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
        String operationVersion =
                ExactAlarmContract.extractOperationVersion(obj);

        if (medicationId.isEmpty()
                || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || !AutoDeductionContract.isValidAmount(amount)
                || scheduledAt < 0L
                || operationVersion.isEmpty()
                || (!treatmentEndDate.isEmpty()
                    && !AutoDeductionContract.isValidCalendarDate(treatmentEndDate))) {
            throw new JSONException("invalid_schedule_record");
        }

        return new AutoDeductionPersistenceModels.ScheduleRecord(
                new AutoDeductionPersistenceModels.OccurrenceId(
                        medicationId, doseId, calendarDate),
                timeHhmm,
                amount,
                scheduledAt,
                treatmentEndDate,
                operationVersion);
    }

    static String encodeRetryEvidence(
            AutoDeductionPersistenceModels.RetryEvidenceRecord record)
            throws JSONException {
        if (record == null
                || record.occurrence == null
                || record.occurrence.medicationId == null
                || record.occurrence.medicationId.isEmpty()
                || record.occurrence.doseId == null
                || record.occurrence.doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(
                        record.occurrence.calendarDate)
                || !AutoDeductionContract.isValidAmount(record.amount)
                || !AutoDeductionContract.isValidTimeHhmm(record.timeHhmm)
                || (!record.treatmentEndDate.isEmpty()
                    && !AutoDeductionContract.isValidCalendarDate(record.treatmentEndDate))
                || record.recurrenceGeneration <= 0L
                || record.operationVersion == null
                || record.operationVersion.isEmpty()
                || record.retryCount <= 0
                || record.updatedAtEpochMs <= 0L) {
            throw new JSONException("invalid_retry_evidence");
        }
        JSONObject obj = new JSONObject();
        obj.put("medicationId", record.occurrence.medicationId);
        obj.put("doseId", record.occurrence.doseId);
        obj.put("calendarDate", record.occurrence.calendarDate);
        obj.put("scheduledAtEpochMs", record.scheduledAtEpochMs);
        obj.put("amount", record.amount);
        obj.put("timeHhmm", record.timeHhmm);
        obj.put("treatmentEndDate", record.treatmentEndDate);
        obj.put("recurrenceGeneration", record.recurrenceGeneration);
        obj.put("operationVersion", record.operationVersion);
        obj.put("retryCount", record.retryCount);
        obj.put("updatedAtEpochMs", record.updatedAtEpochMs);
        return obj.toString();
    }

    static AutoDeductionPersistenceModels.RetryEvidenceRecord decodeRetryEvidence(
            String raw) throws JSONException {
        if (raw == null || raw.isEmpty()) {
            throw new JSONException("invalid_retry_evidence");
        }
        JSONObject obj = new JSONObject(raw);
        String medicationId = obj.optString("medicationId", "").trim();
        String doseId = obj.optString("doseId", "").trim();
        String calendarDate = obj.optString("calendarDate", "").trim();
        long scheduledAt = obj.optLong("scheduledAtEpochMs", -1L);
        double amount = obj.optDouble("amount", Double.NaN);
        String timeHhmm = obj.optString("timeHhmm", "").trim();
        String treatmentEndDate = obj.optString("treatmentEndDate", "").trim();
        long generation = obj.optLong("recurrenceGeneration", 0L);
        String operationVersion = obj.optString("operationVersion", "").trim();
        int retryCount = obj.optInt("retryCount", 0);
        long updatedAt = obj.optLong("updatedAtEpochMs", 0L);

        if (medicationId.isEmpty()
                || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || scheduledAt < 0L
                || !AutoDeductionContract.isValidAmount(amount)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || (!treatmentEndDate.isEmpty()
                    && !AutoDeductionContract.isValidCalendarDate(treatmentEndDate))
                || generation <= 0L
                || operationVersion.isEmpty()
                || retryCount <= 0
                || retryCount > AutoDeductionContract.MAX_FIRE_RETRIES
                || updatedAt <= 0L) {
            throw new JSONException("invalid_retry_evidence");
        }

        return new AutoDeductionPersistenceModels.RetryEvidenceRecord(
                new AutoDeductionPersistenceModels.OccurrenceId(
                        medicationId, doseId, calendarDate),
                scheduledAt,
                amount,
                timeHhmm,
                treatmentEndDate,
                generation,
                operationVersion,
                retryCount,
                updatedAt);
    }

    static String encodeRejected(
            String storageKey,
            String reason,
            long rejectedAtEpochMs)
            throws JSONException {
        JSONObject rejected = new JSONObject();
        rejected.put("status", AutoDeductionContract.STATUS_REJECTED);
        rejected.put("rejectedAt", rejectedAtEpochMs);
        rejected.put(
                "rejectionReason",
                reason == null || reason.isEmpty() ? "invalid_record" : reason);
        rejected.put("storageKey", storageKey);
        return rejected.toString();
    }

    /** Returns the terminal timestamp for a persisted REJECTED row, if present. */
    static Long rejectedAtEpochMs(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            JSONObject obj = new JSONObject(raw);
            if (!AutoDeductionContract.STATUS_REJECTED.equals(
                    obj.optString("status", ""))) {
                return null;
            }
            long value = obj.optLong("rejectedAt", Long.MIN_VALUE);
            return value > 0L ? Long.valueOf(value) : null;
        } catch (JSONException e) {
            return null;
        }
    }

    static String encodeSuccessorObligation(
            AutoDeductionPersistenceModels.SuccessorObligationRecord record)
            throws JSONException {
        if (record == null
                || record.sourceOccurrence == null
                || record.sourceOccurrence.medicationId == null
                || record.sourceOccurrence.medicationId.isEmpty()
                || record.sourceOccurrence.doseId == null
                || record.sourceOccurrence.doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(
                        record.sourceOccurrence.calendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(record.timeHhmm)
                || !AutoDeductionContract.isValidAmount(record.amount)
                || record.recurrenceGeneration <= 0L
                || record.createdAtEpochMs <= 0L) {
            throw new JSONException("invalid_successor_obligation");
        }
        JSONObject obj = new JSONObject();
        obj.put("medicationId", record.sourceOccurrence.medicationId);
        obj.put("doseId", record.sourceOccurrence.doseId);
        obj.put("calendarDate", record.sourceOccurrence.calendarDate);
        obj.put("timeHhmm", record.timeHhmm);
        obj.put("amount", record.amount);
        obj.put("treatmentEndDate", record.treatmentEndDate == null ? "" : record.treatmentEndDate);
        // Empty operationVersion is valid only for historical/overdue source
        // occurrences whose one-shot schedule row has already been consumed.
        // Active/future obligations still carry the owning operationVersion.
        obj.put("operationVersion", record.operationVersion == null ? "" : record.operationVersion);
        obj.put("recurrenceGeneration", record.recurrenceGeneration);
        obj.put("stockApplied", record.stockApplied);
        obj.put("createdAtEpochMs", record.createdAtEpochMs);
        return obj.toString();
    }

    static AutoDeductionPersistenceModels.SuccessorObligationRecord decodeSuccessorObligation(
            String raw)
            throws JSONException {
        if (raw == null || raw.isEmpty()) {
            throw new JSONException("invalid_successor_obligation");
        }
        JSONObject obj = new JSONObject(raw);
        String medicationId = obj.optString("medicationId", "").trim();
        String doseId = obj.optString("doseId", "").trim();
        String calendarDate = obj.optString("calendarDate", "").trim();
        String timeHhmm = obj.optString("timeHhmm", "").trim();
        double amount = obj.optDouble("amount", Double.NaN);
        String treatmentEndDate = obj.optString("treatmentEndDate", "");
        // The field must exist explicitly. Empty is a valid historical value;
        // missing is malformed and must not silently become recovery authority.
        String operationVersion = obj.has("operationVersion")
                ? obj.optString("operationVersion", "")
                : null;
        long generation = obj.optLong("recurrenceGeneration", 0L);
        boolean stockApplied = obj.optBoolean("stockApplied", false);
        long createdAt = obj.optLong("createdAtEpochMs", 0L);

        if (medicationId.isEmpty()
                || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || !AutoDeductionContract.isValidAmount(amount)
                || (!treatmentEndDate.isEmpty()
                    && !AutoDeductionContract.isValidCalendarDate(treatmentEndDate))
                || operationVersion == null
                || generation <= 0L
                || createdAt <= 0L) {
            throw new JSONException("invalid_successor_obligation");
        }

        return new AutoDeductionPersistenceModels.SuccessorObligationRecord(
                new AutoDeductionPersistenceModels.OccurrenceId(
                        medicationId, doseId, calendarDate),
                timeHhmm,
                amount,
                treatmentEndDate,
                operationVersion,
                generation,
                stockApplied,
                createdAt);
    }

    static String statusOf(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        try {
            return new JSONObject(raw).optString("status", "");
        } catch (JSONException e) {
            return "";
        }
    }

    static boolean identityMatchesStorageKey(
            AutoDeductionPersistenceModels.EventRecord record,
            String storageKey,
            String eventPrefix) {
        if (record == null || record.occurrence == null
                || storageKey == null
                || !storageKey.startsWith(eventPrefix)) {
            return false;
        }
        String encoded = storageKey.substring(eventPrefix.length());
        String expected = record.occurrence.canonicalKey();
        return expected.equals(encoded);
    }
}
