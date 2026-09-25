package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.newEventStore;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.pendingPrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * #493: pending-marker cleanup is asynchronous, so recovery must stay
 * crash-safe against a marker that survives its removal. These tests lock
 * the recovery contract that makes the async cleanup safe: a surviving stale
 * marker is re-cleaned idempotently by the next promotion pass and never
 * creates a duplicate FIRED row for the same occurrence.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PendingCleanupIdempotencyTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    private static JSONObject firedPayload(String date) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("medicationId", "med");
        payload.put("doseId", "dose");
        payload.put("calendarDate", date);
        payload.put("scheduledAtEpochMs", 1_000L);
        payload.put("amount", 2.0);
        payload.put("status", AutoDeductionContract.STATUS_FIRED);
        payload.put("createdAtEpochMs", 1_000L);
        return payload;
    }

    @Test
    public void stalePendingMarker_nextToDurableFiredRow_isReCleanedWithoutDoublePromotion()
            throws Exception {
        String date = "2026-09-14";
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        AutoDeductionEventStore store = newEventStore();

        AutoDeductionEventStore.InsertFiredResult inserted =
                store.insertFiredIfAbsent("med", "dose", date, 1_000L, 2.0);
        assertTrue(inserted.isCreated());

        // Simulate an asynchronous stale-marker cleanup that never landed
        // (the process died before the queued removal flushed): the pending
        // marker survives next to its already-durable FIRED row.
        pendingPrefs().edit()
                .putString("pend:" + key, firedPayload(date).toString())
                .commit();

        // The recovery pass re-cleans the marker without creating a second
        // FIRED row: the containsEvent guard classifies it as stale. The
        // promotion count is the pass-level contract (PendingFiresResult);
        // the durable read-model below proves no duplicate row was created.
        AutoDeductionEventStore.PendingFiresResult promotion =
                store.promotePendingFiresResult();
        assertTrue(promotion.ok);
        assertEquals(1, promotion.promoted);

        AutoDeductionEventStore.FiredEventsResult first = store.listFiredEventsResult();
        assertTrue(first.ok);
        assertEquals(1, first.records.size());
        assertTrue(eventPrefs().contains(evtKey(key)));
        assertNull(pendingPrefs().getString("pend:" + key, null));

        // A following pass is a clean no-op.
        AutoDeductionEventStore.FiredEventsResult second = store.listFiredEventsResult();
        assertTrue(second.ok);
        assertEquals(1, second.records.size());
    }

    @Test
    public void pendingFallback_promotesExactlyOnce_evenWhenCleanupSurvivesACrash()
            throws Exception {
        String date = "2026-09-15";
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        String pendingKey = "pend:" + key;

        // Recovery-fallback evidence with no FIRED row: the crash state the
        // pending fallback exists for.
        pendingPrefs().edit()
                .putString(pendingKey, firedPayload(date).toString())
                .commit();

        AutoDeductionEventStore store = newEventStore();

        AutoDeductionEventStore.PendingFiresResult promotion =
                store.promotePendingFiresResult();
        assertTrue(promotion.ok);
        assertEquals(1, promotion.promoted);

        AutoDeductionEventStore.FiredEventsResult first = store.listFiredEventsResult();
        assertTrue(first.ok);
        assertEquals(1, first.records.size());
        assertTrue(eventPrefs().contains(evtKey(key)));

        // Simulate the promotion pass's asynchronous cleanup being lost
        // across a crash: the marker reappears although the FIRED row is
        // already durable.
        pendingPrefs().edit()
                .putString(pendingKey, firedPayload(date).toString())
                .commit();

        // The next pass must re-clean the surviving marker (counted by the
        // pass-level contract) and must not produce a second FIRED record
        // for the same occurrence.
        AutoDeductionEventStore.PendingFiresResult reClean =
                store.promotePendingFiresResult();
        assertTrue(reClean.ok);
        assertEquals(1, reClean.promoted);

        AutoDeductionEventStore.FiredEventsResult second = store.listFiredEventsResult();
        assertTrue(second.ok);
        assertEquals(1, second.records.size());
        assertNull(pendingPrefs().getString(pendingKey, null));
        assertNotNull(eventPrefs().getString(evtKey(key), null));
    }
}
