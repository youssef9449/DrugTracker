package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.newEventStore;
import static org.junit.Assert.assertEquals;
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
 * Phase 4 regression — storage key identity vs payload identity.
 *
 * A FIRED row whose payload carries a DIFFERENT occurrence identity than the
 * identity encoded in its own storage key (all payload fields individually
 * valid) must never be surfaced as FIRED: it is terminalized as REJECTED
 * with reason "identity_mismatch", so a later reconciliation can neither
 * apply the payload identity nor strand the row as FIRED under a key
 * markReconciled would never target.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class EventStoreKeyIdentityTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    /** storage key = occurrence A (med-A/dose-1); payload = occurrence B (med-B/dose-2). */
    private void plantMismatchedRow() throws Exception {
        String keyA = AutoDeductionContract.occurrenceKey("med-A", "dose-1", "2026-09-15");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med-B");
        payload.put("doseId", "dose-2");
        payload.put("calendarDate", "2026-09-15");
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("scheduledAtEpochMs", 1000L);
        payload.put("createdAtEpochMs", 1000L);
        payload.put("reconciledAtEpochMs", JSONObject.NULL);
        eventPrefs().edit().putString(evtKey(keyA), payload.toString()).commit();
    }

    @Test
    public void keyPayloadIdentityMismatch_neverReturnedAsFired_terminalizedRejected()
            throws Exception {
        plantMismatchedRow();
        AutoDeductionEventStore store = newEventStore();

        // Not surfaced as FIRED (payload fields are all individually valid —
        // only the storage-key comparison can detect this corruption).
        AutoDeductionEventStore.FiredEventsResult fired = store.listFiredEventsResult();
        assertTrue(fired.ok);
        assertTrue(fired.records.isEmpty());

        // Terminalized to REJECTED with an explicit identity-mismatch reason.
        String keyA = AutoDeductionContract.occurrenceKey("med-A", "dose-1", "2026-09-15");
        String raw = eventPrefs().getString(evtKey(keyA), null);
        assertNotNull(raw);
        JSONObject row = new JSONObject(raw);
        assertEquals(AutoDeductionContract.STATUS_REJECTED, row.optString("status"));
        assertEquals("identity_mismatch", row.optString("rejectionReason"));
        assertTrue(row.has("rejectedAt"));
    }

    @Test
    public void terminalizationIsIdempotent_secondListStillEmpty()
            throws Exception {
        plantMismatchedRow();
        AutoDeductionEventStore store = newEventStore();
        assertTrue(store.listFiredEventsResult().records.isEmpty());
        assertTrue(store.listFiredEventsResult().records.isEmpty());

        String keyA = AutoDeductionContract.occurrenceKey("med-A", "dose-1", "2026-09-15");
        JSONObject row = new JSONObject(eventPrefs().getString(evtKey(keyA), null));
        assertEquals(AutoDeductionContract.STATUS_REJECTED, row.optString("status"));
    }

    @Test
    public void mismatchedRow_cannotBeReappliedThroughLookup()
            throws Exception {
        plantMismatchedRow();
        AutoDeductionEventStore store = newEventStore();

        // Looking up occurrence A (the storage key identity) must NOT return
        // the row as FIRED: after terminalization it is an explicit no-event.
        AutoDeductionEventStore.EventLookupResult lookupA =
                store.getFiredUnreconciledEvent("med-A", "dose-1", "2026-09-15");
        assertTrue(lookupA.ok);
        assertNull(lookupA.record);

        // Looking up occurrence B (the payload identity) also finds nothing:
        // the payload was never durable under its own key, so a later
        // reconciliation cannot apply the payload to the wrong occurrence.
        AutoDeductionEventStore.EventLookupResult lookupB =
                store.getFiredUnreconciledEvent("med-B", "dose-2", "2026-09-15");
        assertTrue(lookupB.ok);
        assertNull(lookupB.record);

        // The row stays terminal under its own key — no FIRED row remains for
        // markReconciled to miss.
        String keyA = AutoDeductionContract.occurrenceKey("med-A", "dose-1", "2026-09-15");
        JSONObject row = new JSONObject(eventPrefs().getString(evtKey(keyA), null));
        assertEquals(AutoDeductionContract.STATUS_REJECTED, row.optString("status"));
    }

    @Test
    public void malformedTakesPrecedence_whenBothMalformedAndMismatched()
            throws Exception {
        // Invalid amount AND mismatched identity: shared validation reports
        // malformed_fields (same precedence as the single-occurrence lookup).
        String keyA = AutoDeductionContract.occurrenceKey("med-A", "dose-1", "2026-09-15");
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med-B");
        payload.put("doseId", "dose-2");
        payload.put("calendarDate", "2026-09-15");
        payload.put("amount", 0.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("scheduledAtEpochMs", 1000L);
        payload.put("createdAtEpochMs", 1000L);
        eventPrefs().edit().putString(evtKey(keyA), payload.toString()).commit();

        AutoDeductionEventStore store = newEventStore();
        assertTrue(store.listFiredEventsResult().records.isEmpty());
        JSONObject row = new JSONObject(
                eventPrefs().getString(evtKey(keyA), null));
        assertEquals(AutoDeductionContract.STATUS_REJECTED, row.optString("status"));
        assertEquals("malformed_fields", row.optString("rejectionReason"));
    }

    @Test
    public void validRow_matchingKeyIdentity_stillReturnedAsFired() {
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med-A", "dose-1", "2026-09-15", 1000L, 2.0)
                        .status);

        // Positive control: matching key/payload identity keeps surfacing.
        AutoDeductionEventStore.FiredEventsResult fired = store.listFiredEventsResult();
        assertTrue(fired.ok);
        assertEquals(1, fired.records.size());
        assertEquals("med-A", fired.records.get(0).occurrence.medicationId);
        assertEquals("dose-1", fired.records.get(0).occurrence.doseId);
        assertEquals("2026-09-15", fired.records.get(0).occurrence.calendarDate);
        assertEquals(AutoDeductionContract.STATUS_FIRED, fired.records.get(0).status);
    }
}
