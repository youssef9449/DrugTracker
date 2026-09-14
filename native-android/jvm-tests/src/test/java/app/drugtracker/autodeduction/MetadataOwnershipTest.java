package app.drugtracker.autodeduction;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Package-visible {@link AutoDeductionScheduler#isMetadataOwnedByVersion} and
 * recovery matrix helpers — real static Java methods.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MetadataOwnershipTest {

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
}
