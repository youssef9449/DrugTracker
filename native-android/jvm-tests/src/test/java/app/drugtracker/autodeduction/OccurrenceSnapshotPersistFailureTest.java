package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.cancelKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.cancelPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.newScheduler;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 4 regression — native occurrence snapshot fails closed when the
 * EventStore cannot durably terminalize a malformed/mismatched FIRED row.
 *
 * Contract: a persistence failure while reading/terminalizing the FIRED row
 * must surface as an explicit native lookup failure (ok=false,
 * "rejected_persist_failed") — NEVER as an ordinary ABSENT/SCHEDULED/
 * CANCELLED snapshot. The evaluation must stop immediately: no cancellation
 * check, no schedule metadata fallback. Otherwise Manual Take would proceed
 * on schedule/JS amount authority while the durable event ledger state is
 * unknown.
 *
 * Complements OccurrenceSnapshotTest.malformedFiredTerminalizationCommit
 * Failure_returnsFailure_notAbsent (the no-metadata case) by proving the
 * failure also wins over schedule metadata and cancellation tombstones, and
 * that identity-mismatched rows (valid fields) degrade to a safe no-event
 * snapshot once terminalization succeeds.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OccurrenceSnapshotPersistFailureTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    /** Plant a malformed FIRED row (invalid amount) under a valid occurrence key. */
    private void plantMalformedFiredRow(String date) throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "med");
        obj.put("doseId", "dose");
        obj.put("calendarDate", date);
        obj.put("amount", 0.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        obj.put("scheduledAtEpochMs", 1000L);
        obj.put("createdAtEpochMs", 1000L);
        eventPrefs().edit().putString(evtKey(key), obj.toString()).commit();
    }

    @Test
    public void terminalizationCommitFailure_snapshotFailsClosed_notAbsent()
            throws Exception {
        String date = "2026-09-11";
        plantMalformedFiredRow(date);

        try {
            AutoDeductionScheduler.OccurrenceSnapshot snap =
                    new AutoDeductionScheduler(
                            AutoDeductionTestSupport.appContext(),
                            AutoDeductionTestSupport.denyEventCommit()).getOccurrenceSnapshot("med", "dose", date);
            assertFalse(
                    "persistence failure must surface as an explicit failure",
                    snap.ok);
            assertEquals("rejected_persist_failed", snap.error);
            assertNull(snap.amount);

            // The row remains retryable (still FIRED) — recovery is possible.
            String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
            String raw = eventPrefs().getString(evtKey(key), null);
            assertTrue(raw != null
                    && AutoDeductionContract.STATUS_FIRED.equals(
                            new JSONObject(raw).optString("status")));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void persistFailure_beatsScheduleFallback_notUsableAsScheduled()
            throws Exception {
        String date = "2026-09-12";
        plantMalformedFiredRow(date);

        // Durable schedule metadata exists for the same occurrence — the
        // fail-closed result must NOT fall through to a usable SCHEDULED.
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        JSONObject meta = new JSONObject();
        meta.put("amount", 3.0);
        meta.put("timeHhmm", "09:00");
        meta.put("operationVersion", "1-0");
        schedulePrefs().edit().putString(schKey(key), meta.toString()).commit();

        try {
            AutoDeductionScheduler.OccurrenceSnapshot snap =
                    new AutoDeductionScheduler(
                            AutoDeductionTestSupport.appContext(),
                            AutoDeductionTestSupport.denyEventCommit()).getOccurrenceSnapshot("med", "dose", date);
            assertFalse(
                    "schedule metadata must not mask a ledger persistence failure",
                    snap.ok);
            assertEquals("rejected_persist_failed", snap.error);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void persistFailure_beatsCancellation_notUsableAsCancelled()
            throws Exception {
        String date = "2026-09-13";
        plantMalformedFiredRow(date);

        // Cancellation tombstone exists — the fail-closed result must NOT
        // fall through to an ordinary CANCELLED evaluation.
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        cancelPrefs().edit().putString(cancelKey(key), "1-0").commit();

        try {
            AutoDeductionScheduler.OccurrenceSnapshot snap =
                    new AutoDeductionScheduler(
                            AutoDeductionTestSupport.appContext(),
                            AutoDeductionTestSupport.denyEventCommit()).getOccurrenceSnapshot("med", "dose", date);
            assertFalse(
                    "cancellation must not mask a ledger persistence failure",
                    snap.ok);
            assertEquals("rejected_persist_failed", snap.error);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void afterFailureResolved_snapshotRecoversToTerminalRejectedAbsent()
            throws Exception {
        String date = "2026-09-14";
        plantMalformedFiredRow(date);

        // First evaluation under forced failure → fail-closed.
        try {
            AutoDeductionScheduler.OccurrenceSnapshot snap =
                    new AutoDeductionScheduler(
                            AutoDeductionTestSupport.appContext(),
                            AutoDeductionTestSupport.denyEventCommit()).getOccurrenceSnapshot("med", "dose", date);
            assertFalse(snap.ok);
            assertEquals("rejected_persist_failed", snap.error);
        } catch (Exception e) {
            throw new AssertionError(e);
        }

        // Once persistence works again, the row terminalizes to REJECTED and
        // the snapshot reports an ordinary safe ABSENT (no schedule present).
        AutoDeductionScheduler.OccurrenceSnapshot snap =
                new AutoDeductionScheduler(
                        AutoDeductionTestSupport.appContext())
                        .getOccurrenceSnapshot("med", "dose", date);
        assertTrue(snap.ok);
        assertEquals(
                AutoDeductionScheduler.OccurrenceSnapshot.Status.ABSENT,
                snap.status);
        assertNull(snap.amount);

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        JSONObject row = new JSONObject(
                eventPrefs().getString(evtKey(key), null));
        assertEquals(AutoDeductionContract.STATUS_REJECTED, row.optString("status"));
    }

    @Test
    public void identityMismatchedRow_withoutCommitFailure_snapshotIsAbsent_notFired()
            throws Exception {
        // Storage key = med/dose/date; payload = other-med — terminalization
        // succeeds, so the snapshot is an explicit no-event (ABSENT), not a
        // failure and never FIRED.
        String date = "2026-09-15";
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "other-med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", date);
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("scheduledAtEpochMs", 1000L);
        payload.put("createdAtEpochMs", 1000L);
        eventPrefs().edit().putString(evtKey(key), payload.toString()).commit();

        AutoDeductionScheduler.OccurrenceSnapshot snap =
                newScheduler().getOccurrenceSnapshot("med", "dose", date);
        assertTrue(snap.ok);
        assertEquals(AutoDeductionScheduler.OccurrenceSnapshot.Status.ABSENT, snap.status);
        assertNull(snap.amount);
    }
}
