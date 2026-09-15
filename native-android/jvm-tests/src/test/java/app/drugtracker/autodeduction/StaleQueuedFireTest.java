package app.drugtracker.autodeduction;

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

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Issue #240 — a queued exact-alarm delivery from a prior scheduleVersion /
 * recurrenceGeneration must not record FIRED after disable → re-enable reschedule
 * of the same occurrence identity.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class StaleQueuedFireTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

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
        String raw = schedulePrefs().getString(schKey(key), null);
        assertTrue(raw != null && !raw.isEmpty());
        JSONObject o = new JSONObject(raw);
        String v = o.getString("scheduleVersion");
        long g = o.getLong("recurrenceGeneration");
        assertTrue(v != null && !v.isEmpty());
        assertTrue(g > 0L);
        return new DeliveryTokens(v, g);
    }

    private static boolean hasFired(String med, String dose, String date) {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        return eventPrefs().contains(evtKey(key));
    }

    /** Test 1: stale V1/G1 after disable→reschedule V2/G2 cannot FIRE; V2/G2 can. */
    @Test
    public void staleQueuedFire_afterDisableReschedule_rejected_currentAccepted()
            throws Exception {
        String med = "med-stale";
        String dose = "d1";
        String date = futureCalendarDate(3);
        AutoDeductionScheduler s = newScheduler();

        assertTrue(s.scheduleOccurrence(
                med, dose, date, "10:00", 1.0, futureEpochMs(date, "10:00")).ok);
        DeliveryTokens v1g1 = tokensFromMeta(med, dose, date);

        // Disable / invalidate — bumps generation and cancels schedules.
        assertTrue(s.invalidateRecurrenceAuthorization(med, dose).ok);
        assertFalse(schedulePrefs().contains(
                schKey(AutoDeductionContract.occurrenceKey(med, dose, date))));

        // Re-enable same occurrence identity with new ownership tokens.
        assertTrue(s.scheduleOccurrence(
                med, dose, date, "10:00", 1.0, futureEpochMs(date, "10:00")).ok);
        DeliveryTokens v2g2 = tokensFromMeta(med, dose, date);
        assertFalse(v1g1.scheduleVersion.equals(v2g2.scheduleVersion));
        assertTrue(v2g2.recurrenceGeneration > v1g1.recurrenceGeneration);

        // Stale queued delivery V1/G1 must not create FIRED.
        AutoDeductionScheduler.FireResult stale = s.fireOccurrenceIfNotCancelled(
                med, dose, date, 1_000L, 1.0,
                v1g1.scheduleVersion, v1g1.recurrenceGeneration);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, stale.status);
        assertFalse(stale.allowsRecurrence());
        assertFalse(hasFired(med, dose, date));

        // Active schedule metadata for V2/G2 remains intact.
        DeliveryTokens still = tokensFromMeta(med, dose, date);
        assertEquals(v2g2.scheduleVersion, still.scheduleVersion);
        assertEquals(v2g2.recurrenceGeneration, still.recurrenceGeneration);

        // Correct delivery succeeds exactly once.
        AutoDeductionScheduler.FireResult ok = s.fireOccurrenceIfNotCancelled(
                med, dose, date, 2_000L, 1.0,
                v2g2.scheduleVersion, v2g2.recurrenceGeneration);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, ok.status);
        assertTrue(hasFired(med, dose, date));
    }

    /** Test 2: generation mismatch rejects fire. */
    @Test
    public void generationMismatch_rejectsFire() throws Exception {
        String med = "med-gen";
        String dose = "d1";
        String date = futureCalendarDate(2);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                med, dose, date, "11:00", 1.0, futureEpochMs(date, "11:00")).ok);
        DeliveryTokens t = tokensFromMeta(med, dose, date);

        AutoDeductionScheduler.FireResult fr = s.fireOccurrenceIfNotCancelled(
                med, dose, date, 1L, 1.0, t.scheduleVersion, t.recurrenceGeneration + 99L);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, fr.status);
        assertFalse(hasFired(med, dose, date));
    }

    /** Test 3: scheduleVersion mismatch rejects fire. */
    @Test
    public void scheduleVersionMismatch_rejectsFire() throws Exception {
        String med = "med-ver";
        String dose = "d1";
        String date = futureCalendarDate(2);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                med, dose, date, "12:00", 1.0, futureEpochMs(date, "12:00")).ok);
        DeliveryTokens t = tokensFromMeta(med, dose, date);

        AutoDeductionScheduler.FireResult fr = s.fireOccurrenceIfNotCancelled(
                med, dose, date, 1L, 1.0, "not-" + t.scheduleVersion, t.recurrenceGeneration);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, fr.status);
        assertFalse(hasFired(med, dose, date));
    }

    /** Test 4: missing active metadata rejects fire. */
    @Test
    public void missingActiveMetadata_rejectsFire() {
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.FireResult fr = s.fireOccurrenceIfNotCancelled(
                "med-none", "d1", futureCalendarDate(4), 1L, 1.0, "any-version", 1L);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, fr.status);
        assertFalse(hasFired("med-none", "d1", futureCalendarDate(4)));
    }

    /** Test 5: duplicate valid delivery remains idempotent (one FIRED). */
    @Test
    public void duplicateValidDelivery_idempotentOneFired() throws Exception {
        String med = "med-dup";
        String dose = "d1";
        String date = futureCalendarDate(2);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                med, dose, date, "13:00", 1.0, futureEpochMs(date, "13:00")).ok);
        DeliveryTokens t = tokensFromMeta(med, dose, date);

        // The two deliveries share the EXACT same payload (medicationId, doseId,
        // calendarDate, scheduledAtEpochMs, amount, scheduleVersion,
        // recurrenceGeneration) — a true duplicate of one scheduled delivery.
        final long scheduledAt = 1L;
        final double amount = 1.0;

        // First delivery of this occurrence → CREATED.
        AutoDeductionScheduler.FireResult first = s.fireOccurrenceIfNotCancelled(
                med, dose, date, scheduledAt, amount, t.scheduleVersion, t.recurrenceGeneration);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, first.status);

        // Second delivery with the identical payload → idempotent ALREADY_EXISTS.
        AutoDeductionScheduler.FireResult second = s.fireOccurrenceIfNotCancelled(
                med, dose, date, scheduledAt, amount, t.scheduleVersion, t.recurrenceGeneration);
        assertEquals(AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS, second.status);
        // Exactly one durable FIRED — the duplicate delivery did not create a second row.
        assertTrue(hasFired(med, dose, date));
    }
}
