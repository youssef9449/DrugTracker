package app.drugtracker.autodeduction;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Exercises real {@link AutoDeductionScheduler#nextCalendarDate(String)}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class NextCalendarDateTest {

    @Test
    public void nextDay_normal() {
        assertEquals("2026-09-15", AutoDeductionScheduler.nextCalendarDate("2026-09-14"));
    }

    @Test
    public void nextDay_monthBoundary() {
        assertEquals("2026-02-01", AutoDeductionScheduler.nextCalendarDate("2026-01-31"));
        assertEquals("2026-05-01", AutoDeductionScheduler.nextCalendarDate("2026-04-30"));
    }

    @Test
    public void nextDay_yearBoundary() {
        assertEquals("2027-01-01", AutoDeductionScheduler.nextCalendarDate("2026-12-31"));
    }

    @Test
    public void nextDay_leapYearFeb28To29() {
        assertEquals("2024-02-29", AutoDeductionScheduler.nextCalendarDate("2024-02-28"));
    }

    @Test
    public void nextDay_leapYearFeb29ToMar1() {
        assertEquals("2024-03-01", AutoDeductionScheduler.nextCalendarDate("2024-02-29"));
    }

    @Test
    public void nextDay_nonLeapFeb28ToMar1() {
        assertEquals("2025-03-01", AutoDeductionScheduler.nextCalendarDate("2025-02-28"));
    }

    @Test
    public void nextDay_invalidInputReturnsNull() {
        assertNull(AutoDeductionScheduler.nextCalendarDate("2026-02-31"));
        assertNull(AutoDeductionScheduler.nextCalendarDate("bad"));
        assertNull(AutoDeductionScheduler.nextCalendarDate(null));
        assertNull(AutoDeductionScheduler.nextCalendarDate(""));
    }
}
