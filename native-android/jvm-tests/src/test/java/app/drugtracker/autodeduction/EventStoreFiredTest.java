package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.newEventStore;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Real {@link AutoDeductionEventStore#insertFiredIfAbsent} durable insert-if-absent.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class EventStoreFiredTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void firstInsert_created_secondAlreadyExists() {
        AutoDeductionEventStore store = newEventStore();
        AutoDeductionEventStore.InsertFiredResult first =
                store.insertFiredIfAbsent("med", "dose", "2026-09-14", 1_000L, 1.0);
        assertEquals(AutoDeductionEventStore.InsertFiredResult.Status.CREATED, first.status);

        String key = AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14");
        assertTrue(eventPrefs().contains(evtKey(key)));

        AutoDeductionEventStore.InsertFiredResult second =
                store.insertFiredIfAbsent("med", "dose", "2026-09-14", 1_000L, 1.0);
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.ALREADY_EXISTS, second.status);

        // Still a single durable row for that occurrence key.
        int count = 0;
        for (String k : eventPrefs().getAll().keySet()) {
            if (k.startsWith("evt:")) count++;
        }
        assertEquals(1, count);
    }

    @Test
    public void identityIsolation_differentDoseOrDate_separateRows() {
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "am", "2026-09-14", 1L, 1.0).status);
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "pm", "2026-09-14", 1L, 1.0).status);
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "am", "2026-09-15", 1L, 1.0).status);

        int count = 0;
        for (String k : eventPrefs().getAll().keySet()) {
            if (k.startsWith("evt:")) count++;
        }
        assertEquals(3, count);
    }

    @Test
    public void invalidPayload_failsWithoutWriting() {
        AutoDeductionEventStore store = newEventStore();
        AutoDeductionEventStore.InsertFiredResult bad =
                store.insertFiredIfAbsent("", "dose", "2026-09-14", 1L, 1.0);
        assertEquals(AutoDeductionEventStore.InsertFiredResult.Status.FAILED, bad.status);
        assertFalse(bad.pendingRecorded);
        assertTrue(eventPrefs().getAll().isEmpty());
    }
}
