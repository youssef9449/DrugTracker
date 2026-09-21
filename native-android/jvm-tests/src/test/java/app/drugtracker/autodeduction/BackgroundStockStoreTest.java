package app.drugtracker.autodeduction;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;

@RunWith(RobolectricTestRunner.class)
public class BackgroundStockStoreTest {

    private Context context;
    private BackgroundStockStore store;

    @Before
    public void setUp() {
        context = Phase2TestSupport.appContext();
        context.getSharedPreferences(
                "drugtracker_auto_background_stock_v1",
                Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        store = new BackgroundStockStore(context);
    }

    @Test
    public void exactAutoDeductionIsDurableAndIdempotent() {
        BackgroundStockStore.SyncResult sync = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());

        assertTrue(sync.ok);
        assertEquals(10.0d,
                sync.currentPillsByMedication.get("med-1"),
                0.0d);

        BackgroundStockStore.ApplyResult first = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);

        assertTrue(first.ok);
        assertTrue(first.changed);
        assertEquals(8.0d, first.currentPills, 0.0d);
        assertEquals(2.0d, first.deductedAmount, 0.0d);
        assertTrue(first.backgroundVersion > 0L);

        BackgroundStockStore.ApplyResult duplicate = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);

        assertTrue(duplicate.ok);
        assertFalse(duplicate.changed);
        assertEquals(8.0d, duplicate.currentPills, 0.0d);
        assertEquals(0.0d, duplicate.deductedAmount, 0.0d);
    }

    @Test
    public void laterForegroundGenerationAppliesItsDeltaWithoutOverwritingAutoDeduction() {
        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());

        BackgroundStockStore.ApplyResult auto = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);
        assertTrue(auto.changed);
        assertEquals(8.0d, auto.currentPills, 0.0d);

        // JS committed a +3 foreground mutation at generation 2 while the
        // native shadow was already at 8 because Auto ran in between.
        BackgroundStockStore.SyncResult sync = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 13.0d, 2L)),
                2L,
                Collections.emptySet());

        assertTrue(sync.ok);
        assertEquals(
                11.0d,
                sync.currentPillsByMedication.get("med-1"),
                0.0d);
    }

    @Test
    public void sameGenerationHydrationReanchorsBaseBeforeNextForegroundDelta() {
        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());

        BackgroundStockStore.ApplyResult auto = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);
        assertEquals(8.0d, auto.currentPills, 0.0d);

        // App hydration converges JS to the native result without changing
        // the JS stock generation. The same-generation sync must re-anchor
        // baseJsPills to 8, not keep the stale pre-hydration 10.
        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 8.0d, 1L)),
                1L,
                Collections.emptySet());

        BackgroundStockStore.SyncResult next = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 6.0d, 2L)),
                2L,
                Collections.emptySet());

        assertTrue(next.ok);
        assertEquals(6.0d, next.currentPillsByMedication.get("med-1"), 0.0d);
    }

    @Test
    public void staleLowerGenerationCannotOverwriteNewerJsBaseline() {
        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());

        BackgroundStockStore.SyncResult newer = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 15.0d, 2L)),
                2L,
                Collections.emptySet());
        assertTrue(newer.ok);
        assertEquals(15.0d, newer.currentPillsByMedication.get("med-1"), 0.0d);

        // Late delivery of the generation-1 snapshot must not replace the
        // generation-2 JS baseline (15). The next generation-3 +2 mutation
        // therefore produces 17, not an incorrect value derived from 10.
        BackgroundStockStore.SyncResult stale = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());
        assertTrue(stale.ok);
        assertEquals(15.0d, stale.currentPillsByMedication.get("med-1"), 0.0d);

        BackgroundStockStore.SyncResult finalSync = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 17.0d, 3L)),
                3L,
                Collections.emptySet());
        assertTrue(finalSync.ok);
        assertEquals(17.0d, finalSync.currentPillsByMedication.get("med-1"), 0.0d);
    }

    @Test
    public void alreadyAppliedOccurrencePreventsLegacyFireFromBeingDeductedAgain() {
        String occurrence = AutoDeductionContract.occurrenceKey(
                "med-1", "dose-1", "2026-09-21");

        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 7L)),
                7L,
                new HashSet<>(Collections.singletonList(occurrence)));

        BackgroundStockStore.ApplyResult result = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);

        assertTrue(result.ok);
        assertFalse(result.changed);
        assertEquals(10.0d, result.currentPills, 0.0d);
        assertEquals(
                10.0d,
                store.readAllCurrentPills().get("med-1"),
                0.0d);
    }

    @Test
    public void clearAppliedOccurrenceRearmsEligibleOccurrence() {
        String occurrence = AutoDeductionContract.occurrenceKey(
                "med-1", "dose-1", "2026-09-21");

        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                new HashSet<>(Collections.singletonList(occurrence)));

        BackgroundStockStore.SyncResult restored = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 2L)),
                2L,
                Collections.emptySet(),
                new HashSet<>(Collections.singletonList(occurrence)));
        assertTrue(restored.ok);

        BackgroundStockStore.ApplyResult result = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);

        assertTrue(result.ok);
        assertTrue(result.changed);
        assertEquals(8.0d, result.currentPills, 0.0d);
    }

    @Test
    public void manualTakeRaceWithNativeAutoDoesNotDoubleDeduct() {
        String occurrence = AutoDeductionContract.occurrenceKey(
                "med-1", "dose-1", "2026-09-21");

        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());

        BackgroundStockStore.ApplyResult auto = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);
        assertEquals(8.0d, auto.currentPills, 0.0d);

        // Manual Take committed at JS generation 2 with the same occurrence.
        // Native Auto may have fired first, so sync must undo the duplicate
        // native Auto effect before applying the real foreground delta (-2).
        BackgroundStockStore.SyncResult sync = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 8.0d, 2L)),
                2L,
                new HashSet<>(Collections.singletonList(occurrence)),
                Collections.emptySet(),
                new HashSet<>(Collections.singletonList(occurrence)),
                Collections.emptySet());

        assertTrue(sync.ok);
        assertEquals(8.0d, sync.currentPillsByMedication.get("med-1"), 0.0d);

        BackgroundStockStore.ApplyResult duplicate = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);
        assertTrue(duplicate.ok);
        assertFalse(duplicate.changed);
        assertEquals(8.0d, duplicate.currentPills, 0.0d);
    }

    @Test
    public void restoreRaceWithNativeAutoUsesOneNetRestore() {
        String occurrence = AutoDeductionContract.occurrenceKey(
                "med-1", "dose-1", "2026-09-21");

        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());

        BackgroundStockStore.ApplyResult auto = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);
        assertEquals(8.0d, auto.currentPills, 0.0d);

        // JS first converges to the native Auto result without a generation bump.
        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 8.0d, 1L)),
                1L,
                Collections.emptySet());

        // Restore then adds +2 at generation 2 while the native Auto marker is
        // still present. Native sync must compensate the native Auto effect and
        // must not apply the restore twice.
        BackgroundStockStore.SyncResult sync = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 2L)),
                2L,
                new HashSet<>(Collections.singletonList(occurrence)),
                Collections.emptySet(),
                Collections.emptySet(),
                new HashSet<>(Collections.singletonList(occurrence)));

        assertTrue(sync.ok);
        assertEquals(10.0d, sync.currentPillsByMedication.get("med-1"), 0.0d);
    }

    @Test
    public void staleGenerationCannotReintroduceAppliedMarkers() {
        String staleOccurrence = AutoDeductionContract.occurrenceKey(
                "med-1", "dose-2", "2026-09-21");

        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 2L)),
                2L,
                Collections.emptySet());

        BackgroundStockStore.SyncResult stale = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                new HashSet<>(Collections.singletonList(staleOccurrence)));

        assertTrue(stale.ok);

        BackgroundStockStore.ApplyResult result = store.applyAutoDeduction(
                "med-1", "dose-2", "2026-09-21", 2.0d);

        assertTrue(result.ok);
        assertTrue(result.changed);
        assertEquals(8.0d, result.currentPills, 0.0d);
    }

    @Test
    public void zeroActualDeductionStillRecordsNativeAutoMarker() {
        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 0.0d, 1L)),
                1L,
                Collections.emptySet());

        BackgroundStockStore.ApplyResult result = store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);

        assertTrue(result.ok);
        assertTrue(result.changed);
        assertEquals(0.0d, result.currentPills, 0.0d);
        assertEquals(0.0d, result.deductedAmount, 0.0d);

        BackgroundStockStore.OccurrenceSnapshot snapshot =
                store.getOccurrenceSnapshot("med-1", "dose-1", "2026-09-21");
        assertTrue(snapshot.exists);
        assertTrue(snapshot.nativeAuto);
        assertEquals(0.0d, snapshot.deductedAmount, 0.0d);
    }

    @Test
    public void restoreOccurrenceRearmsWithoutExplicitClearList() {
        String occurrence = AutoDeductionContract.occurrenceKey(
                "med-1", "dose-1", "2026-09-21");

        store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 1L)),
                1L,
                Collections.emptySet());

        store.applyAutoDeduction(
                "med-1", "dose-1", "2026-09-21", 2.0d);

        BackgroundStockStore.SyncResult restored = store.syncFromJs(
                Collections.singletonList(
                        new BackgroundStockStore.MedicationState("med-1", 10.0d, 2L)),
                2L,
                Collections.emptySet(),
                Collections.emptySet(),
                Collections.emptySet(),
                new HashSet<>(Collections.singletonList(occurrence)));

        assertTrue(restored.ok);
        assertFalse(store.getOccurrenceSnapshot(
                "med-1", "dose-1", "2026-09-21").exists);
    }

    @Test
    public void missingMedicationDoesNotInventBackgroundStock() {
        BackgroundStockStore.ApplyResult result = store.applyAutoDeduction(
                "missing", "dose-1", "2026-09-21", 2.0d);

        assertFalse(result.ok);
        assertEquals("missing_medication", result.error);
        Map<String, Double> snapshot = store.readAllCurrentPills();
        assertTrue(snapshot.isEmpty());
    }
}
