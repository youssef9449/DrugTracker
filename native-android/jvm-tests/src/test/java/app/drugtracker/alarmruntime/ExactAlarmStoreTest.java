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
        current.put("operationVersion", "1000-2-new");
        current.put("scheduleVersion", "1000-1-old");
        assertTrue("1000-2-new".equals(
                ExactAlarmContract.extractOperationVersion(current)));

        JSONObject legacy = new JSONObject();
        legacy.put("scheduleVersion", "1000-1-old");
        assertTrue("".equals(
                ExactAlarmContract.extractOperationVersion(legacy)));
    }

    @Test
    public void ownership_acceptsOnlyCurrentMetadata() {
        assertTrue(ExactAlarmContract.isMetadataOwnedByOperationVersion(
                "{\"operationVersion\":\"2000-3-new\"}",
                "2000-3-new"));
        assertFalse(ExactAlarmContract.isMetadataOwnedByOperationVersion(
                "{\"scheduleVersion\":\"2000-2-old\"}",
                "2000-2-old"));
        assertFalse(ExactAlarmContract.isMetadataOwnedByOperationVersion(
                "{\"operationVersion\":\"2000-3-new\"}",
                "2000-2-old"));
    }

    @Test
    public void sameMillisecondSequenceOrdersOperations() {
        assertTrue(ExactAlarmContract.isOrderingNewer(
                5000L, 3L, 5000L, 2L));
        assertFalse(ExactAlarmContract.isOrderingNewer(
                5000L, 2L, 5000L, 3L));
    }

    @Test
    public void parseOrdering_rejectsUnversionedOrMalformedValue() {
        assertTrue(ExactAlarmContract.parseOrdering("5000-3-token")[0] == 5000L);
        assertTrue(ExactAlarmContract.parseOrdering("5000-3-token")[1] == 3L);
        assertTrue(ExactAlarmContract.parseOrdering("5000")[0] < 0L);
        assertTrue(ExactAlarmContract.parseOrdering("not-a-token")[0] < 0L);
    }
}
