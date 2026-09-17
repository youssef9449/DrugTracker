package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.evtKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.eventPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newEventStore;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.List;

/**
 * Malformed FIRED events become terminal REJECTED and never reappear from listFiredEvents.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class EventStoreRejectedTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    private void putRaw(String keySuffix, JSONObject obj) throws Exception {
        eventPrefs().edit().putString(evtKey(keySuffix), obj.toString()).commit();
    }

    @Test
    public void missingMedicationId_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "");
        obj.put("doseId", "dose");
        obj.put("calendarDate", "2026-09-14");
        obj.put("amount", 1.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        putRaw(AutoDeductionContract.occurrenceKey("", "dose", "2026-09-14"), obj);

        AutoDeductionEventStore store = newEventStore();
        List<JSONObject> fired = store.listFiredEvents();
        assertTrue(fired.isEmpty());

        // Second call still empty (terminal)
        assertTrue(store.listFiredEvents().isEmpty());

        // listEvents may still see REJECTED
        boolean sawRejected = false;
        for (JSONObject e : store.listEvents()) {
            if (AutoDeductionContract.STATUS_REJECTED.equals(e.optString("status"))) {
                sawRejected = true;
                assertTrue(e.has("rejectedAt"));
            }
        }
        assertTrue(sawRejected);
    }

    @Test
    public void missingDoseId_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "med");
        obj.put("doseId", "");
        obj.put("calendarDate", "2026-09-14");
        obj.put("amount", 1.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        putRaw(AutoDeductionContract.occurrenceKey("med", "", "2026-09-14"), obj);

        assertTrue(newEventStore().listFiredEvents().isEmpty());
    }

    @Test
    public void invalidCalendarDate_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "med");
        obj.put("doseId", "dose");
        obj.put("calendarDate", "not-a-date");
        obj.put("amount", 1.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        putRaw(AutoDeductionContract.occurrenceKey("med", "dose", "not-a-date"), obj);

        assertTrue(newEventStore().listFiredEvents().isEmpty());
    }

    @Test
    public void nonPositiveAmount_markedRejected() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("medicationId", "med");
        obj.put("doseId", "dose");
        obj.put("calendarDate", "2026-09-14");
        obj.put("amount", 0.0);
        obj.put("status", AutoDeductionContract.STATUS_FIRED);
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        putRaw(key, obj);

        assertTrue(newEventStore().listFiredEvents().isEmpty());
    }

    @Test
    public void validFiredUnaffected() {
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "dose", "2026-09-14", 1000L, 2.0).status);

        List<JSONObject> fired = store.listFiredEvents();
        assertEquals(1, fired.size());
        assertEquals(2.0, fired.get(0).optDouble("amount"), 0.0001);
        assertEquals(AutoDeductionContract.STATUS_FIRED, fired.get(0).optString("status"));
    }
    @Test
    public void invalidJsonRow_markedRejected_notReturnedAsFired() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        eventPrefs().edit().putString(evtKey(key), "not-valid-json{{{").commit();

        AutoDeductionEventStore store = newEventStore();
        assertTrue(store.listFiredEvents().isEmpty());
        // Second call still empty (terminal)
        assertTrue(store.listFiredEvents().isEmpty());

        boolean sawRejected = false;
        for (org.json.JSONObject e : store.listEvents()) {
            if (AutoDeductionContract.STATUS_REJECTED.equals(e.optString("status"))) {
                sawRejected = true;
                assertTrue(e.has("rejectedAt"));
                assertEquals("invalid_json", e.optString("rejectionReason"));
            }
        }
        assertTrue(sawRejected);
    }
}
