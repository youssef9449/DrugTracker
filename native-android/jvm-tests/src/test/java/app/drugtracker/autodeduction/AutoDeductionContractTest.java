package app.drugtracker.autodeduction;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.net.Uri;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Executes real {@link AutoDeductionContract} static helpers (not a TS mirror).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AutoDeductionContractTest {

    @Test
    public void occurrenceKey_isolatesMedicationDoseAndDate() {
        String a = AutoDeductionContract.occurrenceKey("m1", "d1", "2026-09-14");
        String same = AutoDeductionContract.occurrenceKey("m1", "d1", "2026-09-14");
        assertEquals(a, same);
        assertNotEquals(a, AutoDeductionContract.occurrenceKey("m2", "d1", "2026-09-14"));
        assertNotEquals(a, AutoDeductionContract.occurrenceKey("m1", "d2", "2026-09-14"));
        assertNotEquals(a, AutoDeductionContract.occurrenceKey("m1", "d1", "2026-09-15"));
    }

    @Test
    public void occurrenceKey_doesNotEmbedTimeOrAmount() {
        String k = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        assertFalse(k.contains("08:00"));
        assertFalse(k.contains("1.5"));
        assertTrue(k.contains("med"));
        assertTrue(k.contains("dose"));
        assertTrue(k.contains("2026-09-14"));
    }

    @Test
    public void occurrenceUri_differsForDistinctTriples() {
        Uri u1 = AutoDeductionContract.occurrenceUri("m", "d1", "2026-09-14");
        Uri u2 = AutoDeductionContract.occurrenceUri("m", "d2", "2026-09-14");
        assertNotNull(u1);
        assertNotEquals(u1, u2);
        assertTrue(u1.toString().contains("occurrence"));
        assertEquals(
                "content://app.drugtracker.autodeduction/occurrence/m/d1/2026-09-14",
                u1.toString());
    }

    @Test
    public void isValidCalendarDate_acceptsLeapDayAndRejectsImpossible() {
        assertTrue(AutoDeductionContract.isValidCalendarDate("2026-09-14"));
        assertTrue(AutoDeductionContract.isValidCalendarDate("2024-02-29"));
        assertTrue(AutoDeductionContract.isValidCalendarDate("2000-02-29"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("2025-02-29"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("1900-02-29"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("2026-02-31"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("2026-13-01"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("2026-00-10"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("2026-09-00"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("2026-9-14"));
        assertFalse(AutoDeductionContract.isValidCalendarDate("2026/09/14"));
        assertFalse(AutoDeductionContract.isValidCalendarDate(null));
        assertFalse(AutoDeductionContract.isValidCalendarDate(""));
    }

    @Test
    public void isValidTimeHhmm_bounds() {
        assertTrue(AutoDeductionContract.isValidTimeHhmm("00:00"));
        assertTrue(AutoDeductionContract.isValidTimeHhmm("23:59"));
        assertTrue(AutoDeductionContract.isValidTimeHhmm("8:00"));
        assertFalse(AutoDeductionContract.isValidTimeHhmm("24:00"));
        assertFalse(AutoDeductionContract.isValidTimeHhmm("12:60"));
        assertFalse(AutoDeductionContract.isValidTimeHhmm("12"));
        assertFalse(AutoDeductionContract.isValidTimeHhmm(null));
    }

    @Test
    public void isValidAmount_rejectsNonPositiveAndNonFinite() {
        assertTrue(AutoDeductionContract.isValidAmount(1.0));
        assertTrue(AutoDeductionContract.isValidAmount(0.5));
        assertFalse(AutoDeductionContract.isValidAmount(0.0));
        assertFalse(AutoDeductionContract.isValidAmount(-1.0));
        assertFalse(AutoDeductionContract.isValidAmount(Double.NaN));
        assertFalse(AutoDeductionContract.isValidAmount(Double.POSITIVE_INFINITY));
    }
}
