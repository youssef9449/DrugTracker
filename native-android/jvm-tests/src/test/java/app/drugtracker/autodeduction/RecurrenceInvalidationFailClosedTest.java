package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.cancelKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.cancelPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.evtKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.eventPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Issue #241 — {@code invalidateRecurrenceAuthorization()} must report {@code ok=false}
 * when any durable occurrence-cancellation step fails (tombstone write, schedule metadata
 * removal, or ordering-token allocation). The generation bump, once committed, stays
 * durable and monotonic — there is <em>no</em> rollback (rollback itself can fail and
 * create authorization ambiguity). The caller retries; retry is idempotent (existing
 * tombstones and already-absent metadata are handled safely).
 *
 * <p>These tests use test-only failure-injection flags on the scheduler instance
 * (mirroring {@code forceRecurrenceAuthCommitFailureForTest}); no production behavior
 * is added, and no sleep/timing hacks are used.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class RecurrenceInvalidationFailClosedTest {

    private AutoDeductionScheduler scheduler;

    @Before
    public void setUp() {
        clearAllDurableState();
        scheduler = newScheduler();
    }

    private long readAuthGeneration(String med, String dose) {
        SharedPreferences p = Phase2TestSupport.appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0);
        return p.getLong(
                AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                        + AutoDeductionContract.scheduleIdentityKey(med, dose),
                0L);
    }

    private boolean hasSchedule(String med, String dose, String date) {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        return schedulePrefs().contains(schKey(key));
    }

    private long genFromScheduleMeta(String med, String dose, String date) throws Exception {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        String raw = schedulePrefs().getString(schKey(key), null);
        if (raw == null) return -1L;
        return new JSONObject(raw).optLong("recurrenceGeneration", 0L);
    }

    /** Test A: tombstone write failure → invalidate ok=false; retry → ok=true (monotonic). */
    @Test
    public void testA_tombstoneWriteFailure_failClosed_retrySucceeds() throws Exception {
        String med = "med-a";
        String dose = "d1";
        String date = futureCalendarDate(2);
        String time = "13:00";
        double amount = 1.0;
        assertTrue(scheduler.scheduleOccurrence(
                med, dose, date, time, amount, futureEpochMs(date, time)).ok);
        long metaGen = genFromScheduleMeta(med, dose, date);
        assertTrue("scheduled occurrence must carry a positive generation", metaGen > 0L);
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);

        scheduler.forceTombstoneCommitFailureForTest = true;
        AutoDeductionScheduler.InvalidateResult failed =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        scheduler.forceTombstoneCommitFailureForTest = false;

        assertFalse("tombstone write failure must NOT report disable success", failed.ok);
        assertEquals("cancellation_tombstone_write_failed", failed.error);
        // No durable protection established yet (no tombstone), metadata still present.
        assertFalse(cancelPrefs().contains(cancelKey(key)));
        assertTrue(hasSchedule(med, dose, date));

        // Retry without failure injection → completes; ok=true; generation monotonic.
        AutoDeductionScheduler.InvalidateResult retry =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertTrue("retry after failure injection must reach ok=true", retry.ok);
        long authGen = readAuthGeneration(med, dose);
        assertTrue("generation must stay monotonic and advance past the metadata gen",
                authGen > metaGen);
        assertFalse("metadata must be removed after successful retry", hasSchedule(med, dose, date));
        assertTrue("tombstone must be present after successful retry",
                cancelPrefs().contains(cancelKey(key)));
    }

    /** Test B: metadata removal failure → ok=false; tombstone guards; retry completes cleanup. */
    @Test
    public void testB_metadataRemovalFailure_failClosed_tombstoneGuards_retryCompletes()
            throws Exception {
        String med = "med-b";
        String dose = "d1";
        String date = futureCalendarDate(3);
        String time = "09:00";
        double amount = 2.0;
        assertTrue(scheduler.scheduleOccurrence(
                med, dose, date, time, amount, futureEpochMs(date, time)).ok);
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);

        scheduler.forceScheduleMetadataRemovalFailureForTest = true;
        AutoDeductionScheduler.InvalidateResult failed =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        scheduler.forceScheduleMetadataRemovalFailureForTest = false;

        assertFalse("metadata removal failure must NOT report disable success", failed.ok);
        assertEquals("schedule_metadata_removal_failed", failed.error);
        // Tombstone WAS written (it precedes metadata removal) — durable stale-fire guard.
        assertTrue("tombstone must remain as the durable guard after metadata-removal failure",
                cancelPrefs().contains(cancelKey(key)));
        // Metadata still present (removal failed).
        assertTrue(hasSchedule(med, dose, date));

        // Retry without failure injection → completes; metadata gone; tombstone kept (idempotent).
        AutoDeductionScheduler.InvalidateResult retry =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertTrue(retry.ok);
        assertFalse("metadata must be removed after successful retry", hasSchedule(med, dose, date));
        assertTrue("tombstone must remain (retry must not rewrite or drop it)",
                cancelPrefs().contains(cancelKey(key)));
    }

    /** Test C: stale fire stays rejected after partial cancellation failure. */
    @Test
    public void testC_partialFailure_staleFireRejected_noFired() throws Exception {
        String med = "med-c";
        String dose = "d1";
        String date = futureCalendarDate(4);
        String time = "08:00";
        double amount = 1.0;
        assertTrue(scheduler.scheduleOccurrence(
                med, dose, date, time, amount, futureEpochMs(date, time)).ok);
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);

        // Capture the active ownership tokens BEFORE invalidate (V1/G1).
        String raw = schedulePrefs().getString(schKey(key), null);
        assertTrue(raw != null);
        JSONObject meta = new JSONObject(raw);
        String v1 = meta.getString("scheduleVersion");
        long g1 = meta.getLong("recurrenceGeneration");

        // Partial failure: tombstone OK, metadata removal fails. Tombstone remains.
        scheduler.forceScheduleMetadataRemovalFailureForTest = true;
        AutoDeductionScheduler.InvalidateResult failed =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        scheduler.forceScheduleMetadataRemovalFailureForTest = false;
        assertFalse(failed.ok);
        assertTrue(cancelPrefs().contains(cancelKey(key)));

        // Stale fire with the OLD ownership tokens (V1/G1) → rejected; no FIRED.
        // The generation bump (auth G2) and the tombstone both block promotion.
        AutoDeductionScheduler.FireResult fr = scheduler.fireOccurrenceIfNotCancelled(
                med, dose, date, 1L, amount, v1, g1);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, fr.status);
        assertFalse("no FIRED may be recorded while cancellation (tombstone) is in place",
                eventPrefs().contains(evtKey(key)));
    }

    /** Test D: first invalidate → partial failure (ok=false); retry → ok=true; no resurrection. */
    @Test
    public void testD_retryAfterPartialFailure_okTrue_noResurrection() throws Exception {
        String med = "med-d";
        String dose = "d1";
        String date = futureCalendarDate(5);
        String time = "10:00";
        double amount = 1.0;
        assertTrue(scheduler.scheduleOccurrence(
                med, dose, date, time, amount, futureEpochMs(date, time)).ok);
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);

        // Capture old tokens for the resurrection check.
        String raw = schedulePrefs().getString(schKey(key), null);
        assertTrue(raw != null);
        JSONObject meta = new JSONObject(raw);
        String v1 = meta.getString("scheduleVersion");
        long g1 = meta.getLong("recurrenceGeneration");

        // First invalidate → partial durable failure → ok=false.
        scheduler.forceTombstoneCommitFailureForTest = true;
        AutoDeductionScheduler.InvalidateResult first =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        scheduler.forceTombstoneCommitFailureForTest = false;
        assertFalse(first.ok);

        // Retry → all durable steps succeed → ok=true.
        AutoDeductionScheduler.InvalidateResult retry =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertTrue("retry after partial failure must reach ok=true", retry.ok);
        assertFalse(hasSchedule(med, dose, date));
        assertTrue(cancelPrefs().contains(cancelKey(key)));

        // No resurrection: a stale delivery with the old tokens cannot create FIRED.
        AutoDeductionScheduler.FireResult stale = scheduler.fireOccurrenceIfNotCancelled(
                med, dose, date, 1L, amount, v1, g1);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, stale.status);
        assertFalse(eventPrefs().contains(evtKey(key)));
    }

    /** Test E: ordering-token allocation failure (allocateOrderingTokenLocked() == null)
     *  → invalidate ok=false (no rollback); retry → ok=true (monotonic, no resurrection). */
    @Test
    public void testE_orderingTokenAllocationFailure_failClosed_retrySucceeds() throws Exception {
        String med = "med-e";
        String dose = "d1";
        String date = futureCalendarDate(6);
        String time = "11:00";
        double amount = 1.0;
        assertTrue(scheduler.scheduleOccurrence(
                med, dose, date, time, amount, futureEpochMs(date, time)).ok);
        long metaGen = genFromScheduleMeta(med, dose, date);
        assertTrue("scheduled occurrence must carry a positive generation", metaGen > 0L);
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);

        // Capture old ownership tokens for the resurrection check.
        String raw = schedulePrefs().getString(schKey(key), null);
        assertTrue(raw != null);
        JSONObject meta = new JSONObject(raw);
        String v1 = meta.getString("scheduleVersion");
        long g1 = meta.getLong("recurrenceGeneration");

        // Force allocateOrderingTokenLocked() to return null → cancellation fails.
        scheduler.forceOrderingTokenAllocationFailureForTest = true;
        AutoDeductionScheduler.InvalidateResult failed =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        scheduler.forceOrderingTokenAllocationFailureForTest = false;

        assertFalse("ordering-token allocation failure must NOT report disable success", failed.ok);
        assertEquals("ordering_sequence_write_failed", failed.error);
        assertEquals("result generation must signal failure (0)", 0L, failed.generation);
        // The generation bump committed BEFORE cancellation; no rollback → auth advanced.
        long authGenAfterFailure = readAuthGeneration(med, dose);
        assertTrue("generation must NOT roll back — it advanced past the metadata gen",
                authGenAfterFailure > metaGen);
        // No durable protection established yet (ordering failed before tombstone/metadata).
        assertFalse(cancelPrefs().contains(cancelKey(key)));
        assertTrue(hasSchedule(med, dose, date));

        // Retry without failure injection → all durable steps succeed.
        AutoDeductionScheduler.InvalidateResult retry =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertTrue("retry after ordering-token failure must reach ok=true", retry.ok);
        long authGenAfterRetry = readAuthGeneration(med, dose);
        assertTrue("generation must stay monotonic across retry", authGenAfterRetry > authGenAfterFailure);
        // Cancellation fully established: metadata gone, tombstone present.
        assertFalse(hasSchedule(med, dose, date));
        assertTrue(cancelPrefs().contains(cancelKey(key)));

        // No resurrection: a stale delivery with the old tokens cannot create FIRED.
        AutoDeductionScheduler.FireResult stale = scheduler.fireOccurrenceIfNotCancelled(
                med, dose, date, 1L, amount, v1, g1);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, stale.status);
        assertFalse(eventPrefs().contains(evtKey(key)));
    }
}
