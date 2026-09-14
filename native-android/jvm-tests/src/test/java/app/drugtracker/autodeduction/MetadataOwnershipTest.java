package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Package-visible ownership and past-metadata helpers on the real scheduler —
 * the #219 stale-snapshot gate and recovery removal matrix.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MetadataOwnershipTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void isMetadataOwnedByVersion_matchesExactScheduleVersion() {
        String json = "{\"scheduleVersion\":\"1000-1-aaa\",\"amount\":1}";
        assertTrue(AutoDeductionScheduler.isMetadataOwnedByVersion(json, "1000-1-aaa"));
        assertFalse(AutoDeductionScheduler.isMetadataOwnedByVersion(json, "1000-2-bbb"));
        assertFalse(AutoDeductionScheduler.isMetadataOwnedByVersion(null, "1000-1-aaa"));
        assertFalse(AutoDeductionScheduler.isMetadataOwnedByVersion(json, null));
        assertFalse(AutoDeductionScheduler.isMetadataOwnedByVersion("{bad", "1000-1-aaa"));
    }

    @Test
    public void shouldRemovePastScheduleMetadata_fireMatrix() {
        assertTrue(AutoDeductionScheduler.shouldRemovePastScheduleMetadata(
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.CREATED, false)));
        assertTrue(AutoDeductionScheduler.shouldRemovePastScheduleMetadata(
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS, false)));
        assertTrue(AutoDeductionScheduler.shouldRemovePastScheduleMetadata(
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.FAILED, true)));
        assertFalse(AutoDeductionScheduler.shouldRemovePastScheduleMetadata(
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.FAILED, false)));
        assertTrue(AutoDeductionScheduler.shouldRemovePastScheduleMetadata(
                AutoDeductionScheduler.FireResult.cancelled()));
    }

    @Test
    public void removeScheduleMetadataIfVersion_onlyWhenSnapshotStillOwnsRow() throws Exception {
        String date = futureCalendarDate(4);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "09:00", 1.0, futureEpochMs(date, "09:00")).ok);

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        String prefKey = schKey(key);
        String raw = schedulePrefs().getString(prefKey, null);
        assertNotNull(raw);
        String v1 = new JSONObject(raw).getString("scheduleVersion");

        // Stale observed version must not delete a newer (or still v1-mismatched) row
        // when the expected token does not match — ownership-safe remove.
        assertFalse(s.removeScheduleMetadataIfVersion(prefKey, "999-1-stale-snapshot"));
        assertTrue(schedulePrefs().contains(prefKey));

        // Matching version removes the row.
        assertTrue(s.removeScheduleMetadataIfVersion(prefKey, v1));
        assertFalse(schedulePrefs().contains(prefKey));
    }

    @Test
    public void rescheduleReplacesVersion_staleObservedVersionCannotRemoveNewerRow() throws Exception {
        String date = futureCalendarDate(5);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "09:00", 1.0, futureEpochMs(date, "09:00")).ok);

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        String prefKey = schKey(key);
        String v1 = new JSONObject(schedulePrefs().getString(prefKey, "{}")).getString("scheduleVersion");

        // Newer legitimate schedule replaces metadata (new scheduleVersion).
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "11:00", 2.0, futureEpochMs(date, "11:00")).ok);
        String v2 = new JSONObject(schedulePrefs().getString(prefKey, "{}")).getString("scheduleVersion");
        assertFalse(v1.equals(v2));

        // Stale snapshot still holding v1 must not delete the v2 row (#219).
        assertFalse(s.removeScheduleMetadataIfVersion(prefKey, v1));
        assertTrue(schedulePrefs().contains(prefKey));
        assertTrue(AutoDeductionScheduler.isMetadataOwnedByVersion(
                schedulePrefs().getString(prefKey, null), v2));
    }
}
