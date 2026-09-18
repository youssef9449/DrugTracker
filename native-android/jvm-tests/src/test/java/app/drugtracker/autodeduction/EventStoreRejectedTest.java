package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.evtKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.eventPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.pendingPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newEventStore;
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

import java.util.List;

/**
 * Malformed FIRED events become terminal REJECTED and never reappear from listFiredEvents.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class EventStoreRejectedTest {

    @Before
    public void setUp() {
        clearAllDurableState();
        AutoDeductionEventStore.__setTestForceCommitResult(null);
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
        List<JSONObject> fired = store.listFiredEvents();
        assertTrue(fired.isEmpty());
        assertTrue(store.listFiredEvents().isEmpty());

        boolean sawRejected = false;
        for (JSONObject e : store.listEvents()) {
            if (AutoDeductionContract.STATUS_REJECTED.equals(e.optString("status"))) {
                sawRejected = true;
                assertTrue(e.has("rejectedAt"));
            }
        }
        assertTrue(sawRejected);
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

        assertTrue(newEventStore().listFiredEvents().isEmpty());
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

        assertTrue(newEventStore().listFiredEvents().isEmpty());
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

        assertTrue(newEventStore().listFiredEvents().isEmpty());
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
        assertTrue(store.listFiredEvents().isEmpty());
        assertTrue(store.listFiredEvents().isEmpty());

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

        AutoDeductionEventStore.__setTestForceCommitResult(false);
        try {
            AutoDeductionEventStore.FiredEventsResult result =
                    newEventStore().listFiredEventsResult();
            assertFalse(result.ok);
            assertTrue(result.events.isEmpty());
            assertEquals("rejected_persist_failed", result.error);
            assertEquals("not-valid-json{{{"
                    , eventPrefs().getString(evtKey(key), null));
        } finally {
            AutoDeductionEventStore.__setTestForceCommitResult(null);
        }
    }

    @Test
    public void validFiredUnaffected() {
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "dose", "2026-09-14", 1000L, 2.0).status);

        List<JSONObject> fired = store.listFiredEvents();
        assertEquals(1, fired.size());
        assertEquals(2.0, fired.get(0).optDouble("amount"), 0.0001);
        assertEquals(AutoDeductionContract.STATUS_FIRED, fired.get(0).optString("status"));
    }

    @Test
    public void invalidJsonRow_markedRejected_notReturnedAsFired() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        eventPrefs().edit().putString(evtKey(key), "not-valid-json{{{").commit();

        AutoDeductionEventStore store = newEventStore();
        assertTrue(store.listFiredEvents().isEmpty());
        assertTrue(store.listFiredEvents().isEmpty());

        boolean sawRejected = false;
        for (JSONObject e : store.listEvents()) {
            if (AutoDeductionContract.STATUS_REJECTED.equals(e.optString("status"))) {
                sawRejected = true;
                assertTrue(e.has("rejectedAt"));
                assertEquals("invalid_json", e.optString("rejectionReason"));
            }
        }
        assertTrue(sawRejected);
    }

    @Test
    public void terminalizationCommitFailure_doesNotSilentlySucceed() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        eventPrefs().edit().putString(evtKey(key), "not-valid-json{{{").commit();

        AutoDeductionEventStore.__setTestForceCommitResult(false);
        try {
            AutoDeductionEventStore store = newEventStore();
            assertTrue(store.listFiredEvents().isEmpty());
            // Commit failed → storage still holds original corrupt value (retryable)
            String raw = eventPrefs().getString(evtKey(key), null);
            assertNotNull(raw);
            assertEquals("not-valid-json{{{", raw);
        } finally {
            AutoDeductionEventStore.__setTestForceCommitResult(null);
        }

        // Without force failure, terminalization succeeds
        AutoDeductionEventStore store2 = newEventStore();
        assertTrue(store2.listFiredEvents().isEmpty());
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
        assertNull(lookup.event);

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

        AutoDeductionEventStore.__setTestForceCommitResult(false);
        try {
            AutoDeductionEventStore.EventLookupResult result =
                    newEventStore().getFiredUnreconciledEvent(
                            "med", "dose", "2026-09-14");
            assertFalse(result.ok);
            assertNull(result.event);
            assertEquals("rejected_persist_failed", result.error);

            // Commit failed: the original FIRED row remains in storage and must
            // not be silently reinterpreted as ABSENT by the caller.
            String raw = eventPrefs().getString(evtKey(key), null);
            assertNotNull(raw);
            JSONObject stillFired = new JSONObject(raw);
            assertEquals(AutoDeductionContract.STATUS_FIRED,
                    stillFired.optString("status"));
        } finally {
            AutoDeductionEventStore.__setTestForceCommitResult(null);
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

        pendingPrefs().edit().putString("pend:" + key, payload.toString()).commit();

        AutoDeductionEventStore.__setTestForceCommitResult(false);
        try {
            AutoDeductionEventStore.EventLookupResult result =
                    newEventStore().getFiredUnreconciledEvent(
                            "med", "dose", date);
            assertFalse(result.ok);
            assertNull(result.event);
            assertEquals("pending_promotion_failed", result.error);
            assertFalse(eventPrefs().contains(evtKey(key)));
            assertNotNull(pendingPrefs().getString("pend:" + key, null));
        } finally {
            AutoDeductionEventStore.__setTestForceCommitResult(null);
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

        pendingPrefs().edit().putString("pend:" + key, payload.toString()).commit();

        AutoDeductionEventStore.__setTestForceCommitResult(false);
        try {
            AutoDeductionEventStore.FiredEventsResult result =
                    newEventStore().listFiredEventsResult();
            assertFalse(result.ok);
            assertTrue(result.events.isEmpty());
            assertEquals("pending_promotion_failed", result.error);
            assertFalse(eventPrefs().contains(evtKey(key)));
            assertNotNull(pendingPrefs().getString("pend:" + key, null));
        } finally {
            AutoDeductionEventStore.__setTestForceCommitResult(null);
        }
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
        JSONObject fired = lookup.event;
        assertNotNull(fired);
        assertEquals("med", fired.optString("medicationId"));
        assertEquals("dose", fired.optString("doseId"));
        assertEquals("2026-09-14", fired.optString("calendarDate"));
        assertEquals(2.0, fired.optDouble("amount"), 0.0001);
        assertEquals(AutoDeductionContract.STATUS_FIRED, fired.optString("status"));
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
        assertNull(lookup.event);

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
        assertNull(lookup.event);

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
        assertNull(lookup.event);

        String after = eventPrefs().getString(evtKey(key), null);
        assertNotNull(after);
        JSONObject obj = new JSONObject(after);
        assertEquals(AutoDeductionContract.STATUS_REJECTED, obj.optString("status"));
        assertEquals("malformed_fields", obj.optString("rejectionReason"));
    }
}
