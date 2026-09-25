package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.newEventStore;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Note-3 hardening: {@link AutoDeductionEventStore#markReconciled} must only
 * acknowledge well-formed FIRED rows whose payload identity matches their
 * storage key. A corrupt FIRED row must be terminalized REJECTED (same as the
 * read paths) instead of being blessed as RECONCILED, and a REJECTED row must
 * never be resurrected through the ack path.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class EventStoreMarkReconciledGuardTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @After
    public void tearDown() {
    }

    private static JSONObject firedRow(String med, String dose, String date, double amount)
            throws Exception {
        JSONObject o = new JSONObject();
        o.put("medicationId", med);
        o.put("doseId", dose);
        o.put("calendarDate", date);
        o.put("scheduledAtEpochMs", 1_000L);
        o.put("amount", amount);
        o.put("status", AutoDeductionContract.STATUS_FIRED);
        o.put("createdAtEpochMs", 1_000L);
        return o;
    }

    private static void writeRow(String prefKey, JSONObject o) {
        eventPrefs().edit().putString(prefKey, o.toString()).commit();
    }

    @Test
    public void validFiredRow_isAcknowledged() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-15");
        writeRow(evtKey(key), firedRow("med", "dose", "2026-09-15", 1.0));

        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med", "dose", "2026-09-15");

        assertTrue(r.ok);
        assertTrue(r.changed);
        JSONObject after = new JSONObject(eventPrefs().getString(evtKey(key), ""));
        assertEquals(AutoDeductionContract.STATUS_RECONCILED, after.optString("status"));
    }

    @Test
    public void alreadyReconciled_isTerminalSuccessWithoutChange() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-15");
        JSONObject reconciled = firedRow("med", "dose", "2026-09-15", 1.0);
        reconciled.put("status", AutoDeductionContract.STATUS_RECONCILED);
        reconciled.put("reconciledAtEpochMs", 2_000L);
        writeRow(evtKey(key), reconciled);

        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med", "dose", "2026-09-15");

        assertTrue(r.ok);
        assertFalse(r.changed);
    }

    @Test
    public void rejectedRow_isNeverResurrected() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-15");
        JSONObject rejected = firedRow("med", "dose", "2026-09-15", 1.0);
        rejected.put("status", AutoDeductionContract.STATUS_REJECTED);
        rejected.put("rejectedAt", 3_000L);
        rejected.put("rejectionReason", "identity_mismatch");
        writeRow(evtKey(key), rejected);

        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med", "dose", "2026-09-15");

        assertTrue("terminal rows must not force an ack retry loop", r.ok);
        assertFalse(r.changed);
        JSONObject after = new JSONObject(eventPrefs().getString(evtKey(key), ""));
        assertEquals(AutoDeductionContract.STATUS_REJECTED, after.optString("status"));
        assertEquals("identity_mismatch", after.optString("rejectionReason"));
        assertFalse("rejected row must not gain reconciledAtEpochMs",
                after.has("reconciledAtEpochMs"));
    }

    @Test
    public void identityMismatchRow_isTerminalizedRejected_notReconciled() throws Exception {
        // Storage key encodes med-A/dose-1; payload claims med-B/dose-2 — the
        // historical stuck-forever shape must never be acknowledged.
        String key = AutoDeductionContract.occurrenceKey("med-A", "dose-1", "2026-09-15");
        writeRow(evtKey(key), firedRow("med-B", "dose-2", "2026-09-15", 1.0));

        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med-A", "dose-1", "2026-09-15");

        assertTrue("handled: corrupt row terminalized, no retry needed", r.ok);
        assertFalse("nothing was acknowledged as RECONCILED", r.changed);
        JSONObject after = new JSONObject(eventPrefs().getString(evtKey(key), ""));
        assertEquals(AutoDeductionContract.STATUS_REJECTED, after.optString("status"));
        assertEquals("identity_mismatch", after.optString("rejectionReason"));
    }

    @Test
    public void malformedFiredRow_isTerminalizedRejected_notReconciled() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-15");
        JSONObject bad = firedRow("med", "dose", "2026-09-15", 1.0);
        bad.put("amount", "not-a-number");
        writeRow(evtKey(key), bad);

        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med", "dose", "2026-09-15");

        assertTrue(r.ok);
        assertFalse(r.changed);
        JSONObject after = new JSONObject(eventPrefs().getString(evtKey(key), ""));
        assertEquals(AutoDeductionContract.STATUS_REJECTED, after.optString("status"));
        assertEquals("malformed_fields", after.optString("rejectionReason"));
    }

    @Test
    public void unknownStatusRow_isRefusedWithoutTerminalization() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-15");
        JSONObject weird = firedRow("med", "dose", "2026-09-15", 1.0);
        weird.put("status", "GARBAGE");
        writeRow(evtKey(key), weird);

        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med", "dose", "2026-09-15");

        assertFalse("unknown status cannot be acknowledged", r.ok);
        assertFalse(r.changed);
        // Untouched — read paths simply ignore non-FIRED rows; the caller
        // converges because the row is never listed as FIRED again.
        assertEquals("GARBAGE",
                new JSONObject(eventPrefs().getString(evtKey(key), "")).optString("status"));
    }

    @Test
    public void invalidJsonRow_isTerminalizedRejected() {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-15");
        eventPrefs().edit().putString(evtKey(key), "{not-json").commit();

        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med", "dose", "2026-09-15");

        assertTrue(r.ok);
        assertFalse(r.changed);
        try {
            JSONObject after = new JSONObject(eventPrefs().getString(evtKey(key), ""));
            assertEquals(AutoDeductionContract.STATUS_REJECTED, after.optString("status"));
            assertEquals("invalid_json", after.optString("rejectionReason"));
        } catch (Exception e) {
            throw new AssertionError("row should be valid REJECTED JSON now", e);
        }
    }

    @Test
    public void missingRow_remainsRetryableFailure() {
        AutoDeductionEventStore.MarkResult r =
                newEventStore().markReconciled("med", "dose", "2026-09-15");
        assertFalse(r.ok);
        assertFalse(r.changed);
    }

    @Test
    public void identityMismatchTerminalization_commitFailure_isRetryable() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med-A", "dose-1", "2026-09-15");
        writeRow(evtKey(key), firedRow("med-B", "dose-2", "2026-09-15", 1.0));

        AutoDeductionEventStore.MarkResult r =
                newEventStore(AutoDeductionTestSupport.denyEventCommit()).markReconciled("med-A", "dose-1", "2026-09-15");

        assertFalse("failed terminalization must remain retryable", r.ok);
        assertFalse(r.changed);
        // Row unchanged (still FIRED payload) — the next read path retries
        // terminalization with the same explicit failure semantics.
        JSONObject after = new JSONObject(eventPrefs().getString(evtKey(key), ""));
        assertEquals(AutoDeductionContract.STATUS_FIRED, after.optString("status"));
    }
}
