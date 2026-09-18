package app.drugtracker.autodeduction;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.TimeZone;

/**
 * DST / midnight boundary behavior of the pure native date helpers
 * ({@code computeEpochMs}, {@code nextCalendarDate}).
 *
 * <p>Wall-clock semantics are pinned with an explicit TimeZone
 * (America/New_York) so the assertions are deterministic on any host machine.
 * The production helpers use the device default timezone via
 * {@code Calendar.getInstance(TimeZone.getDefault(), ...)} — exactly what these
 * tests exercise. Occurrence identity is a WALL CALENDAR date: D+1 chaining
 * must stay a pure +1 calendar day across 23-hour (spring-forward) and
 * 25-hour (fall-back) days, never drift by elapsed-time arithmetic.
 */
public class DstMidnightBoundaryTest {

    private TimeZone original;

    @Before
    public void setUp() {
        original = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"));
    }

    @After
    public void tearDown() {
        TimeZone.setDefault(original);
    }

    @Test
    public void nextCalendarDate_crossesSpringForward_andFallBack() {
        // US 2026: spring forward Sun Mar 8 (02:00 → 03:00), fall back Sun Nov 1.
        assertEquals("2026-03-08", AutoDeductionScheduler.nextCalendarDate("2026-03-07"));
        assertEquals("2026-03-09", AutoDeductionScheduler.nextCalendarDate("2026-03-08"));
        assertEquals("2026-10-31", AutoDeductionScheduler.nextCalendarDate("2026-10-30"));
        assertEquals("2026-11-01", AutoDeductionScheduler.nextCalendarDate("2026-10-31"));
        assertEquals("2026-11-02", AutoDeductionScheduler.nextCalendarDate("2026-11-01"));
    }

    @Test
    public void nextCalendarDate_crossesMonthAndYearAndLeapBoundaries() {
        assertEquals("2026-03-01", AutoDeductionScheduler.nextCalendarDate("2026-02-28"));
        assertEquals("2027-01-01", AutoDeductionScheduler.nextCalendarDate("2026-12-31"));
        assertEquals("2028-03-01", AutoDeductionScheduler.nextCalendarDate("2028-02-29"));
    }

    @Test
    public void computeEpochMs_springForwardGap_isLenientlyNormalized() {
        // 02:30 on Mar 8 2026 does not exist in America/New_York (gap 02:00 →
        // 03:00 EDT). Calendar's lenient field resolution must still produce a
        // valid, deterministic epoch — never null — equal to the 03:30 EDT
        // instant of the same day.
        Long gap = AutoDeductionScheduler.computeEpochMs("2026-03-08", "02:30");
        Long sameDayEarly = AutoDeductionScheduler.computeEpochMs("2026-03-08", "01:30");
        Long sameDayLate = AutoDeductionScheduler.computeEpochMs("2026-03-08", "03:30");
        assertNotNull(gap);
        assertNotNull(sameDayEarly);
        assertNotNull(sameDayLate);
        assertEquals("in-gap wall time resolves to the 03:30 EDT instant",
                sameDayLate.longValue(), gap.longValue());
        assertTrue("normalized gap instant must not precede the pre-gap instant",
                gap.longValue() >= sameDayEarly.longValue());
    }

    @Test
    public void computeEpochMs_fallBackRepeatedHour_precedesPostFallBackTimes() {
        // 01:30 on Nov 1 2026 occurs twice (EDT then EST). Either resolution
        // must still order correctly against wall times after the fall-back
        // boundary, and must never be null.
        Long repeatedHour = AutoDeductionScheduler.computeEpochMs("2026-11-01", "01:30");
        Long afterFallBack = AutoDeductionScheduler.computeEpochMs("2026-11-01", "02:00");
        assertNotNull(repeatedHour);
        assertNotNull(afterFallBack);
        assertTrue("ambiguous 01:30 must precede 02:00 (post-fall-back wall time)",
                repeatedHour.longValue() < afterFallBack.longValue());
    }

    @Test
    public void computeEpochMs_rejectsInvalidInputs() {
        assertNull(AutoDeductionScheduler.computeEpochMs("2026-13-40", "12:00"));
        assertNull(AutoDeductionScheduler.computeEpochMs("2026-01-15", "99:99"));
        assertNull(AutoDeductionScheduler.computeEpochMs("garbage", "12:00"));
    }

    @Test
    public void nextCalendarDate_rejectsInvalidInputs() {
        assertNull(AutoDeductionScheduler.nextCalendarDate("2026-02-30"));
        assertNull(AutoDeductionScheduler.nextCalendarDate("not-a-date"));
    }
}
