package app.drugtracker.alarmruntime;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** Pure durable-ordering/ownership tests for the shared exact-alarm contract helpers. */
public class ExactAlarmStoreTest {

    @Test
    public void extractOperationVersion_readsOnlyCurrentField() throws Exception {
        JSONObject current = new JSONObject();
        current.put("operationVersion", "2-1000-new");
        current.put("scheduleVersion", "1000-1-old");
        assertTrue("2-1000-new".equals(
                ExactAlarmContract.extractOperationVersion(current)));

        JSONObject legacy = new JSONObject();
        legacy.put("scheduleVersion", "1000-1-old");
        assertTrue("".equals(
                ExactAlarmContract.extractOperationVersion(legacy)));
    }

    @Test
    public void ownership_acceptsOnlyCurrentMetadata() {
        assertTrue(ExactAlarmContract.isMetadataOwnedByOperationVersion(
                "{\"operationVersion\":\"3-2000-new\"}",
                "3-2000-new"));
        assertFalse(ExactAlarmContract.isMetadataOwnedByOperationVersion(
                "{\"scheduleVersion\":\"2-2000-old\"}",
                "2-2000-old"));
        assertFalse(ExactAlarmContract.isMetadataOwnedByOperationVersion(
                "{\"operationVersion\":\"3-2000-new\"}",
                "2-2000-old"));
    }

    @Test
    public void sameMillisecondSequenceOrdersOperations() {
        assertTrue(ExactAlarmContract.isOrderingNewer(
                3L, 5000L, 2L, 5000L));
        assertFalse(ExactAlarmContract.isOrderingNewer(
                2L, 5000L, 3L, 5000L));
    }

    @Test
    public void sequenceRemainsNewerAcrossSystemClockRollback() {
        assertTrue(ExactAlarmContract.isOrderingNewer(
                8L, 1_000L, 7L, 9_999_999L));
        assertFalse(ExactAlarmContract.isOrderingNewer(
                7L, 9_999_999L, 8L, 1_000L));
    }

    @Test
    public void parseOrdering_readsSequenceBeforeDiagnosticWallClock() {
        long[] parsed = ExactAlarmContract.parseOrdering("5-5000-token");
        assertTrue(parsed[0] == 5L);
        assertTrue(parsed[1] == 5000L);

        assertTrue(ExactAlarmContract.parseOrdering("5000")[0] < 0L);
        assertTrue(ExactAlarmContract.parseOrdering("not-a-token")[0] < 0L);
    }
}
