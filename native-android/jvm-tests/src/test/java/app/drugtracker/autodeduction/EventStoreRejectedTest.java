package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.pendingPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.newEventStore;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;


/**
 * Malformed FIRED events become terminal REJECTED and never reappear from listFiredEvents.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class EventStoreRejectedTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    private void putRaw(String occurrenceKey, JSONObject obj) throws Exception {
        eventPrefs().edit().putString(evtKey(occurrenceKey), obj.toString()).commit();
    }

    @Test
    public void missingMedicationId_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "");
        obj.put("doseId", "dose");
        obj.put("calendarDate", "2026-09-14");
        obj.put("amount", 1.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        putRaw(AutoDeductionContract.occurrenceKey("", "dose", "2026-09-14"), obj);

        AutoDeductionEventStore store = newEventStore();
        AutoDeductionEventStore.FiredEventsResult fired = store.listFiredEventsResult();
        assertTrue(fired.ok);
        assertTrue(fired.records.isEmpty());
        String rejectedRaw = eventPrefs().getString(
                evtKey(AutoDeductionContract.occurrenceKey("", "dose", "2026-09-14")),
                null);
        assertNotNull(rejectedRaw);
        JSONObject rejected = new JSONObject(rejectedRaw);
        assertEquals(AutoDeductionContract.STATUS_REJECTED,
                rejected.optString("status"));
        assertTrue(rejected.has("rejectedAt"));
    }

    @Test
    public void missingDoseId_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "med");
        obj.put("doseId", "");
        obj.put("calendarDate", "2026-09-14");
        obj.put("amount", 1.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        putRaw(AutoDeductionContract.occurrenceKey("med", "", "2026-09-14"), obj);

        assertTrue(newEventStore().listFiredEventsResult().records.isEmpty());
    }

    @Test
    public void invalidCalendarDate_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "med");
        obj.put("doseId", "dose");
        obj.put("calendarDate", "not-a-date");
        obj.put("amount", 1.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        putRaw(AutoDeductionContract.occurrenceKey("med", "dose", "not-a-date"), obj);

        assertTrue(newEventStore().listFiredEventsResult().records.isEmpty());
    }

    @Test
    public void nonPositiveAmount_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "med");
        obj.put("doseId", "dose");
        obj.put("calendarDate", "2026-09-14");
        obj.put("amount", 0.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        putRaw(key, obj);

        assertTrue(newEventStore().listFiredEventsResult().records.isEmpty());
    }

    @Test
    public void storageKeyPayloadIdentityMismatch_markedRejected_notReturnedAsFired() throws Exception {
        String storageKey = AutoDeductionContract.occurrenceKey(
                "med-a", "dose-a", "2026-09-14");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med-b");
        payload.put("doseId", "dose-b");
        payload.put("calendarDate", "2026-09-14");
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        putRaw(storageKey, payload);

        AutoDeductionEventStore store = newEventStore();
        assertTrue(store.listFiredEventsResult().records.isEmpty());
        assertTrue(store.listFiredEventsResult().records.isEmpty());

        String raw = eventPrefs().getString(evtKey(storageKey), null);
        assertNotNull(raw);
        JSONObject rejected = new JSONObject(raw);
        assertEquals(AutoDeductionContract.STATUS_REJECTED,
                rejected.optString("status"));
        assertEquals("identity_mismatch",
                rejected.optString("rejectionReason"));
    }

    @Test
    public void bulkList_terminalizationCommitFailure_returnsFailure() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        eventPrefs().edit().putString(evtKey(key), "not-valid-json{{{").commit();

        try {
            AutoDeductionEventStore.FiredEventsResult result =
                    newEventStore(AutoDeductionTestSupport.denyEventCommit()).listFiredEventsResult();
            assertFalse(result.ok);
            assertTrue(result.records.isEmpty());
            assertEquals("rejected_persist_failed", result.error);
            assertEquals("not-valid-json{{{"
                    , eventPrefs().getString(evtKey(key), null));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void validFiredUnaffected() {
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "dose", "2026-09-14", 1000L, 2.0).status);

        AutoDeductionEventStore.FiredEventsResult fired = store.listFiredEventsResult();
        assertTrue(fired.ok);
        assertEquals(1, fired.records.size());
        assertEquals(2.0, fired.records.get(0).amount, 0.0001);
        assertEquals(AutoDeductionContract.STATUS_FIRED, fired.records.get(0).status);
    }

    @Test
    public void invalidJsonRow_markedRejected_notReturnedAsFired() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        eventPrefs().edit().putString(evtKey(key), "not-valid-json{{{").commit();

        AutoDeductionEventStore store = newEventStore();
        assertTrue(store.listFiredEventsResult().records.isEmpty());
        assertTrue(store.listFiredEventsResult().records.isEmpty());

        String rejectedRaw = eventPrefs().getString(evtKey(key), null);
        assertNotNull(rejectedRaw);
        JSONObject rejected = new JSONObject(rejectedRaw);
        assertEquals(AutoDeductionContract.STATUS_REJECTED,
                rejected.optString("status"));
        assertTrue(rejected.has("rejectedAt"));
        assertEquals("invalid_json",
                rejected.optString("rejectionReason"));
    }

    @Test
    public void terminalizationCommitFailure_doesNotSilentlySucceed() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        eventPrefs().edit().putString(evtKey(key), "not-valid-json{{{").commit();

        try {
            AutoDeductionEventStore store = newEventStore(AutoDeductionTestSupport.denyEventCommit());
            assertTrue(store.listFiredEventsResult().records.isEmpty());
            // Commit failed → storage still holds original corrupt value (retryable)
            String raw = eventPrefs().getString(evtKey(key), null);
            assertNotNull(raw);
            assertEquals("not-valid-json{{{", raw);
        } catch (Exception e) {
            throw new AssertionError(e);
        }

        // With the normal persistence policy, terminalization succeeds.
        AutoDeductionEventStore store2 = newEventStore();
        assertTrue(store2.listFiredEventsResult().records.isEmpty());
        String after = eventPrefs().getString(evtKey(key), null);
        assertNotNull(after);
        JSONObject obj = new JSONObject(after);
        assertEquals(AutoDeductionContract.STATUS_REJECTED, obj.optString("status"));
    }

    @Test
    public void getFiredUnreconciledEvent_mismatchedIdentity_returnsAbsentAndRejects()
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "other-med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", "2026-09-14");
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("scheduledAtEpochMs", 1000L);
        payload.put("createdAtEpochMs", 1000L);
        eventPrefs().edit().putString(evtKey(key), payload.toString()).commit();

        AutoDeductionEventStore store = newEventStore();
        AutoDeductionEventStore.EventLookupResult lookup =
                store.getFiredUnreconciledEvent("med", "dose", "2026-09-14");
        assertTrue(lookup.ok);
        assertNull(lookup.record);

        String after = eventPrefs().getString(evtKey(key), null);
        assertNotNull(after);
        JSONObject obj = new JSONObject(after);
        assertEquals(AutoDeductionContract.STATUS_REJECTED, obj.optString("status"));
        assertEquals("identity_mismatch", obj.optString("rejectionReason"));
    }

    @Test
    public void getFiredUnreconciledEvent_terminalizationCommitFailure_returnsFailure() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "other-med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", "2026-09-14");
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        eventPrefs().edit().putString(evtKey(key), payload.toString()).commit();

        try {
            AutoDeductionEventStore.EventLookupResult result =
                    newEventStore(AutoDeductionTestSupport.denyEventCommit()).getFiredUnreconciledEvent(
                            "med", "dose", "2026-09-14");
            assertFalse(result.ok);
            assertNull(result.record);
            assertEquals("rejected_persist_failed", result.error);

            // Commit failed: the original FIRED row remains in storage and must
            // not be silently reinterpreted as ABSENT by the caller.
            String raw = eventPrefs().getString(evtKey(key), null);
            assertNotNull(raw);
            JSONObject stillFired = new JSONObject(raw);
            assertEquals(AutoDeductionContract.STATUS_FIRED,
                    stillFired.optString("status"));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void getFiredUnreconciledEvent_pendingPromotionCommitFailure_failsClosed() throws Exception {
        String date = "2026-09-16";
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", date);
        payload.put("scheduledAtEpochMs", 1_000L);
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("createdAtEpochMs", 1_000L);

        pendingPrefs().edit().putString("pend:" + key, payload.toString()).commit();

        try {
            AutoDeductionEventStore.EventLookupResult result =
                    newEventStore(AutoDeductionTestSupport.denyEventCommit()).getFiredUnreconciledEvent(
                            "med", "dose", date);
            assertFalse(result.ok);
            assertNull(result.record);
            assertEquals("pending_promotion_failed", result.error);
            assertFalse(eventPrefs().contains(evtKey(key)));
            assertNotNull(pendingPrefs().getString("pend:" + key, null));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void listFiredEventsResult_pendingPromotionCommitFailure_failsClosed() throws Exception {
        String date = "2026-09-17";
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", date);
        payload.put("scheduledAtEpochMs", 1_000L);
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("createdAtEpochMs", 1_000L);

        pendingPrefs().edit().putString("pend:" + key, payload.toString()).commit();

        try {
            AutoDeductionEventStore.FiredEventsResult result =
                    newEventStore(AutoDeductionTestSupport.denyEventCommit()).listFiredEventsResult();
            assertFalse(result.ok);
            assertTrue(result.records.isEmpty());
            assertEquals("pending_promotion_failed", result.error);
            assertFalse(eventPrefs().contains(evtKey(key)));
            assertNotNull(pendingPrefs().getString("pend:" + key, null));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void malformedPendingRecord_isQuarantinedAndRemovedOnlyAfterSuccessfulCommit()
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey(
                "med-bad", "dose", "2026-09-18");
        String pendingKey = "pend:" + key;

        pendingPrefs().edit()
                .putString(pendingKey, "not-valid-json{{{")
                .commit();

        AutoDeductionEventStore.FiredEventsResult result =
                newEventStore().listFiredEventsResult();

        assertTrue(result.ok);
        assertTrue(result.records.isEmpty());
        assertFalse(pendingPrefs().contains(pendingKey));

        String quarantined = pendingPrefs().getString(
                AutoDeductionEventStore.KEY_PENDING_QUARANTINE_PREFIX + key,
                null);
        assertNotNull(quarantined);
        JSONObject quarantine = new JSONObject(quarantined);
        assertEquals("QUARANTINED", quarantine.optString("status"));
        assertEquals("malformed_pending_record",
                quarantine.optString("reason"));
        assertEquals(pendingKey, quarantine.optString("originalKey"));
        assertEquals("not-valid-json{{{", quarantine.optString("raw"));
    }

    @Test
    public void malformedPendingDoesNotBlockValidNeighborPromotion() throws Exception {
        String badKey = AutoDeductionContract.occurrenceKey(
                "med-bad", "dose", "2026-09-19");
        String goodKey = AutoDeductionContract.occurrenceKey(
                "med-good", "dose", "2026-09-19");

        pendingPrefs().edit()
                .putString("pend:" + badKey, "not-valid-json{{{")
                .putString("pend:" + goodKey,
                        firedPayload("med-good", "dose", "2026-09-19", 2.0))
                .commit();

        AutoDeductionEventStore.FiredEventsResult result =
                newEventStore().listFiredEventsResult();

        assertTrue(result.ok);
        assertEquals(1, result.records.size());
        assertEquals("med-good",
                result.records.get(0).occurrence.medicationId);
        assertTrue(eventPrefs().contains("evt:" + goodKey));
        assertFalse(pendingPrefs().contains("pend:" + goodKey));
        assertFalse(pendingPrefs().contains("pend:" + badKey));
        assertNotNull(pendingPrefs().getString(
                AutoDeductionEventStore.KEY_PENDING_QUARANTINE_PREFIX + badKey,
                null));
    }

    @Test
    public void quarantineCommitFailure_keepsMalformedPendingEvidence() throws Exception {
        String key = AutoDeductionContract.occurrenceKey(
                "med-bad", "dose", "2026-09-20");
        String pendingKey = "pend:" + key;
        pendingPrefs().edit()
                .putString(pendingKey, "not-valid-json{{{")
                .commit();

        AutoDeductionFailurePolicy denyQuarantine =
                new AutoDeductionFailurePolicy() {
                    @Override
                    public boolean allowPendingQuarantineCommit() {
                        return false;
                    }
                };

        AutoDeductionEventStore.FiredEventsResult result =
                newEventStore(denyQuarantine).listFiredEventsResult();

        assertFalse(result.ok);
        assertTrue(result.records.isEmpty());
        assertNotNull(pendingPrefs().getString(pendingKey, null));
        assertTrue(pendingPrefs().getString(
                AutoDeductionEventStore.KEY_PENDING_QUARANTINE_PREFIX + key,
                null) == null);
    }

    private static String firedPayload(
            String medicationId,
            String doseId,
            String calendarDate,
            double amount) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("medicationId", medicationId);
        payload.put("doseId", doseId);
        payload.put("calendarDate", calendarDate);
        payload.put("scheduledAtEpochMs", 1_000L);
        payload.put("amount", amount);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("createdAtEpochMs", 1_000L);
        return payload.toString();
    }

    @Test
    public void getFiredUnreconciledEvent_matchingIdentity_returnsFired() {
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "dose", "2026-09-14", 1000L, 2.0).status);

        AutoDeductionEventStore.EventLookupResult lookup =
                store.getFiredUnreconciledEvent("med", "dose", "2026-09-14");
        assertTrue(lookup.ok);
        AutoDeductionPersistenceModels.EventRecord fired = lookup.record;
        assertNotNull(fired);
        assertEquals("med", fired.occurrence.medicationId);
        assertEquals("dose", fired.occurrence.doseId);
        assertEquals("2026-09-14", fired.occurrence.calendarDate);
        assertEquals(2.0, fired.amount, 0.0001);
        assertEquals(AutoDeductionContract.STATUS_FIRED, fired.status);
    }

    @Test
    public void listFiredEventsResult_reconciledEvent_remainsTerminalAndUntouched() throws Exception {
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "dose", "2026-09-14", 1000L, 2.0).status);
        AutoDeductionEventStore.MarkResult marked =
                store.markReconciled("med", "dose", "2026-09-14");
        assertTrue(marked.ok);
        assertTrue(marked.changed);

        AutoDeductionEventStore.FiredEventsResult listed = store.listFiredEventsResult();
        assertTrue(listed.ok);
        assertTrue(listed.records.isEmpty());

        JSONObject persisted = new JSONObject(
                eventPrefs().getString(
                        evtKey(AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14")),
                        null));
        assertEquals(
                AutoDeductionContract.STATUS_RECONCILED,
                persisted.optString("status"));
    }

    @Test
    public void getFiredUnreconciledEvent_doseIdMismatch_returnsAbsentAndRejects()
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med");
        payload.put("doseId", "other-dose");
        payload.put("calendarDate", "2026-09-14");
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("scheduledAtEpochMs", 1000L);
        payload.put("createdAtEpochMs", 1000L);
        eventPrefs().edit().putString(evtKey(key), payload.toString()).commit();

        AutoDeductionEventStore store = newEventStore();
        AutoDeductionEventStore.EventLookupResult lookup =
                store.getFiredUnreconciledEvent("med", "dose", "2026-09-14");
        assertTrue(lookup.ok);
        assertNull(lookup.record);

        String after = eventPrefs().getString(evtKey(key), null);
        assertNotNull(after);
        JSONObject obj = new JSONObject(after);
        assertEquals(AutoDeductionContract.STATUS_REJECTED, obj.optString("status"));
        assertEquals("malformed_fields", obj.optString("rejectionReason"));
    }

    @Test
    public void getFiredUnreconciledEvent_calendarDateMismatch_returnsAbsentAndRejects()
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", "2026-09-15");
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("scheduledAtEpochMs", 1000L);
        payload.put("createdAtEpochMs", 1000L);
        eventPrefs().edit().putString(evtKey(key), payload.toString()).commit();

        AutoDeductionEventStore store = newEventStore();
        AutoDeductionEventStore.EventLookupResult lookup =
                store.getFiredUnreconciledEvent("med", "dose", "2026-09-14");
        assertTrue(lookup.ok);
        assertNull(lookup.record);

        String after = eventPrefs().getString(evtKey(key), null);
        assertNotNull(after);
        JSONObject obj = new JSONObject(after);
        assertEquals(AutoDeductionContract.STATUS_REJECTED, obj.optString("status"));
        assertEquals("malformed_fields", obj.optString("rejectionReason"));
    }

    @Test
    public void getFiredUnreconciledEvent_invalidAmount_returnsAbsentAndRejects()
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", "2026-09-14");
        payload.put("amount", 0.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("scheduledAtEpochMs", 1000L);
        payload.put("createdAtEpochMs", 1000L);
        eventPrefs().edit().putString(evtKey(key), payload.toString()).commit();

        AutoDeductionEventStore store = newEventStore();
        AutoDeductionEventStore.EventLookupResult lookup =
                store.getFiredUnreconciledEvent("med", "dose", "2026-09-14");
        assertTrue(lookup.ok);
        assertNull(lookup.record);

        String after = eventPrefs().getString(evtKey(key), null);
        assertNotNull(after);
        JSONObject obj = new JSONObject(after);
        assertEquals(AutoDeductionContract.STATUS_REJECTED, obj.optString("status"));
        assertEquals("malformed_fields", obj.optString("rejectionReason"));
    }
}
