package app.drugtracker.autodeduction;

import org.json.JSONException;

/**
 * Read-side query/validation responsibilities for the Auto-Deduction event
 * store (#467).
 *
 * Owns the storage-identity contract: parsing durable event keys into
 * occurrence identities and validating that a payload matches the key it is
 * stored under. Pure static logic — no persistence access, no state
 * transitions, no mutation. The store (storage + transitions + compaction)
 * and its query/list paths consume these helpers so the identity contract
 * exists in exactly one place.
 */
final class AutoDeductionEventQueries {

    private AutoDeductionEventQueries() {}

    /** Parsed identity of one durable event storage key. */
    static final class StorageIdentity {
        final String medicationId;
        final String doseId;
        final String calendarDate;

        StorageIdentity(
                String medicationId,
                String doseId,
                String calendarDate) {
            this.medicationId = medicationId;
            this.doseId = doseId;
            this.calendarDate = calendarDate;
        }
    }

    private static final char OCCURRENCE_KEY_SEPARATOR = '\u001f';

    /**
     * Parse an event storage key (<code>evt:&lt;med>\u001f&lt;dose>\u001f&lt;date></code>)
     * into its occurrence identity; null when the key shape is invalid.
     */
    static StorageIdentity parseStorageKeyIdentity(
            String eventKeyPrefix,
            String prefKey) {
        if (prefKey == null || !prefKey.startsWith(eventKeyPrefix)) return null;
        String encoded = prefKey.substring(eventKeyPrefix.length());
        int first = encoded.indexOf(OCCURRENCE_KEY_SEPARATOR);
        int second = first >= 0
                ? encoded.indexOf(OCCURRENCE_KEY_SEPARATOR, first + 1)
                : -1;
        if (first <= 0 || second <= first + 1 || second >= encoded.length() - 1) {
            return null;
        }
        if (encoded.indexOf(OCCURRENCE_KEY_SEPARATOR, second + 1) >= 0) {
            return null;
        }
        return new StorageIdentity(
                encoded.substring(0, first),
                encoded.substring(first + 1, second),
                encoded.substring(second + 1));
    }

    /** True when a decoded record belongs to the key it was stored under. */
    static boolean storageIdentityMatchesPayload(
            StorageIdentity identity,
            AutoDeductionPersistenceModels.EventRecord record) {
        if (identity == null || record == null || record.occurrence == null) {
            return false;
        }
        return identity.medicationId.equals(record.occurrence.medicationId)
                && identity.doseId.equals(record.occurrence.doseId)
                && identity.calendarDate.equals(record.occurrence.calendarDate);
    }

    /**
     * Classify a raw durable payload for the recovery read model: FIRED rows
     * with key-consistent identities are returned; every other outcome is
     * described as a structured rejection reason for the caller's terminal
     * transition. Query/validation only — the caller owns the writes.
     */
    static final class FiredRowClassification {
        final AutoDeductionPersistenceModels.EventRecord firedRecord;
        final String rejectionReason;

        private FiredRowClassification(
                AutoDeductionPersistenceModels.EventRecord firedRecord,
                String rejectionReason) {
            this.firedRecord = firedRecord;
            this.rejectionReason = rejectionReason;
        }

        boolean isFired() {
            return firedRecord != null;
        }
    }

    /**
     * Classify one durable event row for the FIRED recovery read model.
     *
     * @param decoded result of decoding the raw payload
     * @param raw     the raw stored string (for raw-field inspection)
     * @param identity parsed storage identity of the row's key
     */
    static FiredRowClassification classifyFiredRow(
            AutoDeductionPersistenceCodec.DecodeResult decoded,
            String raw,
            StorageIdentity identity) {
        if (AutoDeductionContract.STATUS_REJECTED.equals(decoded.status)) {
            return new FiredRowClassification(null, null);
        }
        // RECONCILED is a valid terminal event and must remain untouched.
        // Only FIRED rows are candidates for the recovery read model.
        if (decoded.isSuccess()
                && AutoDeductionContract.STATUS_RECONCILED.equals(decoded.record.status)) {
            return new FiredRowClassification(null, null);
        }
        if (decoded.isSuccess()
                && AutoDeductionContract.STATUS_FIRED.equals(decoded.record.status)
                && storageIdentityMatchesPayload(identity, decoded.record)) {
            return new FiredRowClassification(decoded.record, null);
        }

        String rejectionReason;
        String rawStatus = "";
        String rawMedicationId = "";
        String rawDoseId = "";
        String rawCalendarDate = "";
        double rawAmount = Double.NaN;
        try {
            org.json.JSONObject rawObject = new org.json.JSONObject(raw);
            rawStatus = rawObject.optString("status", "");
            rawMedicationId = rawObject.optString("medicationId", "").trim();
            rawDoseId = rawObject.optString("doseId", "").trim();
            rawCalendarDate = rawObject.optString("calendarDate", "").trim();
            rawAmount = rawObject.optDouble("amount", Double.NaN);
        } catch (JSONException ignored) {
            // Keep the invalid-json classification below.
        }

        boolean validIdentityPayload =
                AutoDeductionContract.STATUS_FIRED.equals(rawStatus)
                        && !rawMedicationId.isEmpty()
                        && !rawDoseId.isEmpty()
                        && AutoDeductionContract.isValidCalendarDate(rawCalendarDate)
                        && AutoDeductionContract.isValidAmount(rawAmount);

        if ("invalid_json".equals(decoded.error)) {
            rejectionReason = "invalid_json";
        } else if (validIdentityPayload
                && identity != null
                && !identity.medicationId.equals(rawMedicationId)) {
            // A valid FIRED payload stored under another medication's
            // key is specifically an identity corruption.
            rejectionReason = "identity_mismatch";
        } else {
            rejectionReason = "malformed_fields";
        }
        return new FiredRowClassification(null, rejectionReason);
    }
}
