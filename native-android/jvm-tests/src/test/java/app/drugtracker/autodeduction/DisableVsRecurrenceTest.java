package app.drugtracker.autodeduction;

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

/** Issue #217 — disable/cancel vs post-fire recurrence scheduling. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class DisableVsRecurrenceTest {

    private AutoDeductionScheduler scheduler;

    @Before
    public void setUp() {
        Phase2TestSupport.clearAllDurableState();
        scheduler = new AutoDeductionScheduler(Phase2TestSupport.appContext());
    }

    private static String futureDate(int days) {
        return Phase2TestSupport.futureCalendarDate(days);
    }

    private long readGen(String med, String dose) {
        SharedPreferences p = Phase2TestSupport.appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0);
        return p.getLong(
                AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                        + AutoDeductionContract.scheduleIdentityKey(med, dose),
                0L);
    }

    private boolean hasSchedule(String med, String dose, String date) {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        return Phase2TestSupport.schedulePrefs().contains(Phase2TestSupport.schKey(key));
    }

    private long genFromScheduleMeta(String med, String dose, String date) throws Exception {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        String raw = Phase2TestSupport.schedulePrefs().getString(
                Phase2TestSupport.schKey(key), null);
        if (raw == null) return -1L;
        return new JSONObject(raw).optLong("recurrenceGeneration", 0L);
    }

    /** Active ownership tokens (Issue #240) read from schedule metadata. */
    private static final class DeliveryTokens {
        final String scheduleVersion;
        final long recurrenceGeneration;

        DeliveryTokens(String scheduleVersion, long recurrenceGeneration) {
            this.scheduleVersion = scheduleVersion;
            this.recurrenceGeneration = recurrenceGeneration;
        }
    }

    private static DeliveryTokens tokensFromMeta(String med, String dose, String date)
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        String raw = Phase2TestSupport.schedulePrefs().getString(
                Phase2TestSupport.schKey(key), null);
        assertTrue(raw != null && !raw.isEmpty());
        JSONObject o = new JSONObject(raw);
        String v = o.getString("scheduleVersion");
        long g = o.getLong("recurrenceGeneration");
        assertTrue(v != null && !v.isEmpty());
        assertTrue(g > 0L);
        return new DeliveryTokens(v, g);
    }

    @Test
    public void caseA_fireThenDisableThenRecurrence_doesNotCreateSuccessor() throws Exception {
        String med = "med-a";
        String dose = "d1";
        String d = futureDate(2);
        String time = "10:00";
        double amount = 1.0;

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, amount, 0L).ok);
        DeliveryTokens t = tokensFromMeta(med, dose, d);
        assertTrue(t.recurrenceGeneration > 0L);

        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(
                        med, dose, d, System.currentTimeMillis(), amount,
                        t.scheduleVersion, t.recurrenceGeneration);
        assertTrue(fr.allowsRecurrence());

        AutoDeductionScheduler.InvalidateResult inv =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertTrue(inv.ok);
        assertTrue(readGen(med, dose) > t.recurrenceGeneration);

        AutoDeductionScheduler.ScheduleResult next =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, amount, t.recurrenceGeneration);
        assertFalse(next.ok);
        assertEquals("recurrence_authorization_invalid", next.error);
    }

    @Test
    public void caseB_successorThenDisable_cancelsAndRestoreDoesNotResurrect() throws Exception {
        String med = "med-b";
        String dose = "d1";
        String d = futureDate(2);
        String time = "11:00";
        double amount = 2.0;

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, amount, 0L).ok);
        DeliveryTokens t = tokensFromMeta(med, dose, d);

        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(
                        med, dose, d, System.currentTimeMillis(), amount,
                        t.scheduleVersion, t.recurrenceGeneration);
        assertTrue(fr.allowsRecurrence());

        AutoDeductionScheduler.ScheduleResult next =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, amount, t.recurrenceGeneration);
        assertTrue(next.ok);

        String d1Date = null;
        for (String k : Phase2TestSupport.schedulePrefs().getAll().keySet()) {
            if (!k.startsWith(Phase2TestSupport.SCH_PREFIX)) continue;
            JSONObject o = new JSONObject(
                    Phase2TestSupport.schedulePrefs().getString(k, "{}"));
            if (med.equals(o.optString("medicationId"))
                    && dose.equals(o.optString("doseId"))
                    && !d.equals(o.optString("calendarDate"))) {
                d1Date = o.optString("calendarDate");
            }
        }
        assertTrue(d1Date != null && !d1Date.isEmpty());
        assertTrue(hasSchedule(med, dose, d1Date));

        assertTrue(scheduler.invalidateRecurrenceAuthorization(med, dose).ok);
        assertFalse(hasSchedule(med, dose, d1Date));

        scheduler.restoreFutureSchedules();
        assertFalse(hasSchedule(med, dose, d1Date));
    }

    @Test
    public void caseC_disableBeforeRecurrence_noSuccessor() throws Exception {
        String med = "med-c";
        String dose = "d1";
        String d = futureDate(3);
        String time = "09:00";

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, 1.0, 0L).ok);
        long gen = genFromScheduleMeta(med, dose, d);

        assertTrue(scheduler.invalidateRecurrenceAuthorization(med, dose).ok);

        AutoDeductionScheduler.ScheduleResult next =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, 1.0, gen);
        assertFalse(next.ok);
        assertEquals("recurrence_authorization_invalid", next.error);
    }

    @Test
    public void caseD_occurrenceCancel_stillBlocksFire() throws Exception {
        String med = "med-d";
        String dose = "d1";
        String d = futureDate(2);

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, "08:00", 1.0, 0L).ok);
        DeliveryTokens t = tokensFromMeta(med, dose, d);
        assertTrue(scheduler.cancelOccurrence(med, dose, d).isOk());

        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(
                        med, dose, d, System.currentTimeMillis(), 1.0,
                        t.scheduleVersion, t.recurrenceGeneration);
        assertTrue(fr.isCancelled());
    }

    @Test
    public void caseE_staleGeneration_cannotCreateSuccessor() throws Exception {
        String med = "med-e";
        String dose = "d1";
        String d = futureDate(2);

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, "12:00", 1.0, 0L).ok);
        long oldGen = genFromScheduleMeta(med, dose, d);

        assertTrue(scheduler.invalidateRecurrenceAuthorization(med, dose).ok);
        String d2 = futureDate(3);
        assertTrue(scheduler.scheduleOccurrence(med, dose, d2, "12:00", 1.0, 0L).ok);
        long newGen = genFromScheduleMeta(med, dose, d2);
        assertTrue(newGen > oldGen);

        AutoDeductionScheduler.ScheduleResult stale =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d2, "12:00", 1.0, oldGen);
        assertFalse(stale.ok);
        assertEquals("recurrence_authorization_invalid", stale.error);
    }

    @Test
    public void caseF_cancelWins_noFired() throws Exception {
        String med = "med-f";
        String dose = "d1";
        String d = futureDate(2);

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, "13:00", 1.0, 0L).ok);
        DeliveryTokens t = tokensFromMeta(med, dose, d);
        assertTrue(scheduler.cancelOccurrence(med, dose, d).isOk());
        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(
                        med, dose, d, System.currentTimeMillis(), 1.0,
                        t.scheduleVersion, t.recurrenceGeneration);
        assertTrue(fr.isCancelled());
        assertFalse(fr.allowsRecurrence());
    }

    /** Fail-closed: generation commit failure must not report success or bump gen. */
    @Test
    public void generationCommitFailure_isFailClosed_noInvalidateSuccess() throws Exception {
        String med = "med-fail";
        String dose = "d1";
        String d = futureDate(2);
        String time = "10:30";

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, 1.0, 0L).ok);
        long genBefore = genFromScheduleMeta(med, dose, d);
        assertTrue(genBefore > 0L);

        // Also install a successor candidate metadata path: schedule next day slot
        // is not required — we only need generation + authorization semantics.
        scheduler.forceRecurrenceAuthCommitFailureForTest = true;
        AutoDeductionScheduler.InvalidateResult failed =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        scheduler.forceRecurrenceAuthCommitFailureForTest = false;

        assertFalse("commit failure must not return ok", failed.ok);
        assertEquals("recurrence_generation_commit_failed", failed.error);
        assertEquals("generation must remain unchanged on failed commit",
                genBefore, readGen(med, dose));

        // Old generation is still authorized — successor creation is still allowed
        // (disable did not take effect). That is intentional fail-closed for disable,
        // not for scheduleNext.
        AutoDeductionScheduler.ScheduleResult stillAuthorized =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, 1.0, genBefore);
        assertTrue(
                "without a successful bump, expectedGen still matches active",
                stillAuthorized.ok);

        // Retry succeeds: generation bumps and old gen is no longer authorized.
        AutoDeductionScheduler.InvalidateResult ok =
                scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertTrue(ok.ok);
        assertTrue(readGen(med, dose) > genBefore);

        AutoDeductionScheduler.ScheduleResult denied =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, 1.0, genBefore);
        assertFalse(denied.ok);
        assertEquals("recurrence_authorization_invalid", denied.error);
    }

    /**
     * Concurrent fire vs invalidate: after both complete, a successor must not
     * remain authorized under a generation that was successfully invalidated.
     * Uses CountDownLatch so both threads contend on SCHEDULE_LOCK (not sleep).
     */
    @Test
    public void concurrentFireAndInvalidate_neverLeavesAuthorizedSuccessorForStaleGen()
            throws Exception {
        String med = "med-race";
        String dose = "d1";
        String d = futureDate(2);
        String time = "15:00";
        double amount = 1.0;

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, amount, 0L).ok);
        final long genBefore = genFromScheduleMeta(med, dose, d);
        assertTrue(genBefore > 0L);
        final DeliveryTokens t = tokensFromMeta(med, dose, d);

        final java.util.concurrent.CountDownLatch start =
                new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.atomic.AtomicReference<AutoDeductionScheduler.FireResult>
                fireRef = new java.util.concurrent.atomic.AtomicReference<>();
        final java.util.concurrent.atomic.AtomicReference<AutoDeductionScheduler.InvalidateResult>
                invRef = new java.util.concurrent.atomic.AtomicReference<>();
        final java.util.concurrent.atomic.AtomicReference<AutoDeductionScheduler.ScheduleResult>
                nextRef = new java.util.concurrent.atomic.AtomicReference<>();

        Thread fireThread = new Thread(() -> {
            try {
                start.await();
                AutoDeductionScheduler.FireResult fr =
                        scheduler.fireOccurrenceIfNotCancelled(
                                med, dose, d, System.currentTimeMillis(), amount,
                                t.scheduleVersion, t.recurrenceGeneration);
                fireRef.set(fr);
                if (fr != null && fr.allowsRecurrence()) {
                    // Same path as AutoDeductionReceiver after FIRED.
                    nextRef.set(scheduler.scheduleNextOccurrenceIfAbsent(
                            med, dose, d, time, amount, genBefore));
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "fire-race");

        Thread invThread = new Thread(() -> {
            try {
                start.await();
                invRef.set(scheduler.invalidateRecurrenceAuthorization(med, dose));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "invalidate-race");

        fireThread.start();
        invThread.start();
        start.countDown();
        fireThread.join(10_000L);
        invThread.join(10_000L);
        assertFalse("fire thread hung", fireThread.isAlive());
        assertFalse("invalidate thread hung", invThread.isAlive());

        AutoDeductionScheduler.InvalidateResult inv = invRef.get();
        AutoDeductionScheduler.ScheduleResult next = nextRef.get();
        long genAfter = readGen(med, dose);

        if (inv != null && inv.ok) {
            // Disable linearized with durable bump — stale gen must not authorize D+1.
            assertTrue(genAfter > genBefore);
            AutoDeductionScheduler.ScheduleResult after =
                    scheduler.scheduleNextOccurrenceIfAbsent(
                            med, dose, d, time, amount, genBefore);
            assertFalse(
                    "stale generation must not create successor after successful invalidate",
                    after.ok);
            assertEquals("recurrence_authorization_invalid", after.error);

            // If race-created successor existed, cancelAll must have removed it.
            for (String k : Phase2TestSupport.schedulePrefs().getAll().keySet()) {
                if (!k.startsWith(Phase2TestSupport.SCH_PREFIX)) continue;
                org.json.JSONObject o = new org.json.JSONObject(
                        Phase2TestSupport.schedulePrefs().getString(k, "{}"));
                if (!med.equals(o.optString("medicationId"))
                        || !dose.equals(o.optString("doseId"))) {
                    continue;
                }
                // Any remaining row must not carry the pre-invalidate generation
                // as an active authorized schedule for a successor date.
                long rowGen = o.optLong("recurrenceGeneration", 0L);
                String rowDate = o.optString("calendarDate", "");
                if (!d.equals(rowDate) && rowGen == genBefore) {
                    throw new AssertionError(
                            "successor still present with pre-invalidate generation: " + k);
                }
            }
        } else {
            // Invalidate failed or lost the race without ok — generation not claimed bumped.
            // If next was scheduled under genBefore, that is consistent with active gen.
            if (next != null && next.ok) {
                assertEquals(
                        "successor only ok when generation still matches genBefore",
                        genBefore,
                        genAfter);
            }
        }
    }
}
