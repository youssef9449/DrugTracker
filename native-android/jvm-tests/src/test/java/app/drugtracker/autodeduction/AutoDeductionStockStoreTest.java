package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.appContext;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Native Auto stock authority tests.
 *
 * The store is deliberately small: one live currentPills balance per
 * medication, occurrence-idempotent Auto markers, and a monotonic foreground
 * mutation sequence. These tests verify that background Auto and foreground
 * stock changes can safely share the same authority.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AutoDeductionStockStoreTest {

    private AutoDeductionStockStore store;

    @Before
    public void setUp() {
        clearAllDurableState();
        store = new AutoDeductionStockStore(appContext());
    }

    @Test
    public void seedMissingStock_usesJsOnlyForMissingRows() {
        List<AutoDeductionStockStore.StockSeed> seeds = new ArrayList<>();
        seeds.add(new AutoDeductionStockStore.StockSeed("med-1", 20.0));

        AutoDeductionStockStore.SnapshotResult first = store.ensureMissingAndRead(seeds);

        assertTrue(first.ok);
        assertTrue(store.isInitialized());
        assertEquals(20.0, first.stocks.get("med-1"), 0.0001);

        AutoDeductionStockStore.AutoApplyResult applied =
                store.applyAutoDeduction("med-1", "dose-1", "2026-09-21", 3.0);
        assertTrue(applied.ok);
        assertTrue(applied.applied);
        assertEquals(3.0, applied.actualDeducted, 0.0001);
        assertEquals(17.0, applied.currentPills, 0.0001);

        List<AutoDeductionStockStore.StockSeed> staleSeeds = new ArrayList<>();
        staleSeeds.add(new AutoDeductionStockStore.StockSeed("med-1", 99.0));
        AutoDeductionStockStore.SnapshotResult second =
                store.ensureMissingAndRead(staleSeeds);

        assertTrue(second.ok);
        assertEquals(
                "existing Native balance must beat stale JS seed",
                17.0,
                second.stocks.get("med-1"),
                0.0001);
    }

    @Test
    public void autoOccurrence_isExactlyOnceAndReturnsOriginalActualAmount() {
        store.ensureMissingAndRead(java.util.Collections.singletonList(
                new AutoDeductionStockStore.StockSeed("med-1", 5.0)));

        AutoDeductionStockStore.AutoApplyResult first =
                store.applyAutoDeduction("med-1", "dose-1", "2026-09-21", 7.0);
        AutoDeductionStockStore.AutoApplyResult second =
                store.applyAutoDeduction("med-1", "dose-1", "2026-09-21", 7.0);

        assertTrue(first.ok);
        assertTrue(first.applied);
        assertEquals(5.0, first.actualDeducted, 0.0001);
        assertEquals(0.0, first.currentPills, 0.0001);

        assertTrue(second.ok);
        assertFalse(second.applied);
        assertEquals(5.0, second.actualDeducted, 0.0001);
        assertEquals(0.0, second.currentPills, 0.0001);
    }

    @Test
    public void existingCorruptNativeStockRow_failsClosedInsteadOfUsingJsBaseline() {
        appContext().getSharedPreferences(
                "drugtracker_auto_stock_v1",
                android.content.Context.MODE_PRIVATE)
                .edit()
                .putString("stock:med-1", "not-a-number")
                .commit();

        AutoDeductionStockStore.SnapshotResult result =
                store.ensureMissingAndRead(java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed("med-1", 20.0)));

        assertFalse(result.ok);
        assertEquals("invalid_native_stock", result.error);
        assertFalse("corrupt stock must not initialize Native baseline",
                store.isInitialized());
    }

    @Test
    public void uninitializedStore_rejectsAutoExecutionUntilBaselineExists() {
        assertFalse(store.isInitialized());

        AutoDeductionStockStore.AutoApplyResult result =
                store.applyAutoDeduction(
                        "med-1", "dose-1", "2026-09-21", 2.0);

        assertFalse(result.ok);
        assertEquals("stock_not_initialized", result.error);
    }

    @Test
    public void autoOccurrence_doesNotNeedJsOrMedicationSnapshotAtFireTime() {
        store.ensureMissingAndRead(java.util.Collections.singletonList(
                new AutoDeductionStockStore.StockSeed("med-1", 10.0)));

        AutoDeductionStockStore.AutoApplyResult applied =
                store.applyAutoDeduction(
                        "med-1",
                        "dose-1",
                        "2026-09-21",
                        2.0);

        assertTrue(applied.ok);
        assertEquals(8.0, applied.currentPills, 0.0001);

        AutoDeductionStockStore.SnapshotResult all = store.readAll();
        assertTrue(all.ok);
        assertEquals(8.0, all.stocks.get("med-1"), 0.0001);
    }

    @Test
    public void foregroundDelta_isIdempotentAndPreservesBackgroundDeduction() {
        store.ensureMissingAndRead(java.util.Collections.singletonList(
                new AutoDeductionStockStore.StockSeed("med-1", 10.0)));

        AutoDeductionStockStore.AutoApplyResult auto =
                store.applyAutoDeduction("med-1", "dose-1", "2026-09-21", 2.0);
        assertTrue(auto.ok);
        assertEquals(8.0, auto.currentPills, 0.0001);

        List<AutoDeductionStockStore.StockDelta> refill =
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockDelta("med-1", 5.0));

        AutoDeductionStockStore.ForegroundApplyResult first =
                store.applyForegroundDeltas(10L, refill);
        AutoDeductionStockStore.ForegroundApplyResult second =
                store.applyForegroundDeltas(10L, refill);

        assertTrue(first.ok);
        assertFalse(first.alreadyApplied);
        assertEquals(13.0, first.stocks.get("med-1"), 0.0001);
        assertTrue(second.ok);
        assertEquals(13.0, second.stocks.get("med-1"), 0.0001);
        assertTrue(second.alreadyApplied);

        AutoDeductionStockStore.SnapshotResult snapshot = store.readAll();
        assertTrue(snapshot.ok);
        assertEquals(
                "10 - 2 Auto + 5 foreground refill",
                13.0,
                snapshot.stocks.get("med-1"),
                0.0001);
    }

    @Test
    public void seedCanImportLegacyOccurrenceResolutionWithoutChangingStock() {
        AutoDeductionStockStore.OccurrenceResolution resolution =
                new AutoDeductionStockStore.OccurrenceResolution(
                        "med-1",
                        "dose-1",
                        "2026-09-21",
                        AutoDeductionStockStore.OccurrenceResolution.Type.CONSUMED);

        AutoDeductionStockStore.SnapshotResult result =
                store.ensureMissingAndRead(
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.StockSeed("med-1", 8.0)),
                        java.util.Collections.singletonList(resolution));

        assertTrue(result.ok);
        assertEquals(8.0, result.stocks.get("med-1"), 0.0001);

        AutoDeductionStockStore.AutoApplyResult auto =
                store.applyAutoDeduction("med-1", "dose-1", "2026-09-21", 2.0);

        assertTrue(auto.ok);
        assertFalse(auto.applied);
        assertEquals(0.0, auto.actualDeducted, 0.0001);
        assertEquals(8.0, auto.currentPills, 0.0001);
    }

    @Test
    public void foregroundConsumedResolution_preventsSameOccurrenceAutoDeduction() {
        store.ensureMissingAndRead(java.util.Collections.singletonList(
                new AutoDeductionStockStore.StockSeed("med-1", 10.0)));

        AutoDeductionStockStore.ForegroundApplyResult manual =
                store.applyForegroundDeltas(
                        10L,
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.StockDelta("med-1", -2.0)),
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.OccurrenceResolution(
                                        "med-1",
                                        "dose-1",
                                        "2026-09-21",
                                        AutoDeductionStockStore.OccurrenceResolution.Type.CONSUMED)));

        assertTrue(manual.ok);
        assertEquals(8.0, manual.stocks.get("med-1"), 0.0001);

        AutoDeductionStockStore.AutoApplyResult auto =
                store.applyAutoDeduction("med-1", "dose-1", "2026-09-21", 2.0);

        assertTrue(auto.ok);
        assertFalse(auto.applied);
        assertEquals(
                "manual Take already consumed the exact occurrence",
                0.0,
                auto.actualDeducted,
                0.0001);
        assertEquals(8.0, auto.currentPills, 0.0001);
    }

    @Test
    public void foregroundSkippedResolution_preventsLaterAutoDeduction() {
        store.ensureMissingAndRead(java.util.Collections.singletonList(
                new AutoDeductionStockStore.StockSeed("med-1", 10.0)));

        AutoDeductionStockStore.ForegroundApplyResult restore =
                store.applyForegroundDeltas(
                        11L,
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.StockDelta("med-1", 2.0)),
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.OccurrenceResolution(
                                        "med-1",
                                        "dose-1",
                                        "2026-09-21",
                                        AutoDeductionStockStore.OccurrenceResolution.Type.SKIPPED)));

        assertTrue(restore.ok);
        assertEquals(12.0, restore.stocks.get("med-1"), 0.0001);

        AutoDeductionStockStore.AutoApplyResult auto =
                store.applyAutoDeduction("med-1", "dose-1", "2026-09-21", 2.0);

        assertTrue(auto.ok);
        assertFalse(auto.applied);
        assertEquals(0.0, auto.actualDeducted, 0.0001);
        assertEquals(12.0, auto.currentPills, 0.0001);
    }

    @Test
    public void zeroDelta_canInitializeNewMedicationStockRow() {
        AutoDeductionStockStore.ForegroundApplyResult result =
                store.applyForegroundDeltas(
                        21L,
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.StockDelta("new-med", 0.0)));

        assertTrue(result.ok);
        assertFalse(result.alreadyApplied);
        assertEquals(0.0, result.stocks.get("new-med"), 0.0001);
        assertTrue(store.isInitialized());

        AutoDeductionStockStore.AutoApplyResult auto =
                store.applyAutoDeduction("new-med", "dose-1", "2026-09-21", 1.0);
        assertTrue("zero-stock Auto occurrence must still become a terminal occurrence",
                auto.ok);
        assertEquals(0.0, auto.actualDeducted, 0.0001);
        assertEquals(0.0, auto.currentPills, 0.0001);
    }

    @Test
    public void foregroundNegativeDelta_onUnknownMedication_failsClosed() {
        AutoDeductionStockStore.ForegroundApplyResult result =
                store.applyForegroundDeltas(
                        20L,
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.StockDelta("missing", -1.0)));

        assertFalse(result.ok);
        assertFalse(result.alreadyApplied);
        assertEquals("stock_not_initialized", result.error);
    }

    @Test
    public void differentForegroundMutationSeqs_areAppliedInOrder() {
        store.ensureMissingAndRead(java.util.Collections.singletonList(
                new AutoDeductionStockStore.StockSeed("med-1", 10.0)));

        AutoDeductionStockStore.ForegroundApplyResult first =
                store.applyForegroundDeltas(
                        30L,
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.StockDelta("med-1", -3.0)));
        AutoDeductionStockStore.ForegroundApplyResult second =
                store.applyForegroundDeltas(
                        31L,
                        java.util.Collections.singletonList(
                                new AutoDeductionStockStore.StockDelta("med-1", 4.0)));

        assertTrue(first.ok);
        assertTrue(second.ok);

        AutoDeductionStockStore.SnapshotResult snapshot = store.readAll();
        assertEquals(11.0, snapshot.stocks.get("med-1"), 0.0001);
    }
}
