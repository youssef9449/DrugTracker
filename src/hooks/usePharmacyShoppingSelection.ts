import { useEffect, useMemo, useState } from 'react';
import type { Medication } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';

export interface UsePharmacyShoppingSelectionOptions {
  medications: Medication[];
}

export function usePharmacyShoppingSelection({
  medications,
}: UsePharmacyShoppingSelectionOptions) {
  const urgentMeds = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    });
  }, [medications]);
  const [showAllForPlanning, setShowAllForPlanning] = useState(false);
  const [removedFromShoppingIds, setRemovedFromShoppingIds] = useState<Set<string>>(new Set());
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set());
  const effectiveShowAll = showAllForPlanning;
  const displayList = (effectiveShowAll ? medications : urgentMeds)
    .filter((medication) => !removedFromShoppingIds.has(medication.id));
  const [selectedMedIds, setSelectedMedIds] = useState<Set<string>>(() => {
    return new Set(urgentMeds.map((m) => m.id));
  });
  // #20 + #34: reconcile the selection and deselectedIds
  // against the displayed list. This effect:
  //   - Auto-selects any displayed med not yet selected AND not in
  //     `deselectedIds` (so manual deselects are preserved — #20).
  //   - Prunes ids that are no longer displayed from `selectedMedIds` and
  //     `deselectedIds`.
  // Each updater returns the SAME Set reference when nothing changed
  // so React skips the re-render (avoids an infinite loop since
  // `deselectedIds` is in the deps array).
  useEffect(() => {
    const displayedIds = new Set(displayList.map((m) => m.id));
    setSelectedMedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const m of displayList) {
        if (!next.has(m.id) && !deselectedIds.has(m.id)) { next.add(m.id); changed = true; }
      }
      for (const id of next) {
        if (!displayedIds.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
    setDeselectedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of next) {
        if (!displayedIds.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [displayList, deselectedIds]);
  const handleToggleSelect = (id: string) => {
    // Read current values from the closure (not from setState updaters) and
    // compute both next states, then call both setters sequentially. The
    // previous version called setDeselectedIds from inside the
    // setSelectedMedIds updater — unsafe under React 18+ concurrent
    // rendering / StrictMode because updaters must be pure.
    const nextSelected = new Set(selectedMedIds);
    const nextDeselected = new Set(deselectedIds);
    if (nextSelected.has(id)) {
      nextSelected.delete(id);
      // #20: record the explicit deselect.
      nextDeselected.add(id);
    } else {
      nextSelected.add(id);
      // #20: clear the deselect record on re-select.
      nextDeselected.delete(id);
    }
    setSelectedMedIds(nextSelected);
    setDeselectedIds(nextDeselected);
  };
  const handleRemoveFromShopping = (id: string) => {
    setRemovedFromShoppingIds((prev) => new Set(prev).add(id));
    setSelectedMedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setDeselectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  return {
    showAllForPlanning,
    setShowAllForPlanning,
    displayList,
    selectedMedIds,
    handleToggleSelect,
    handleRemoveFromShopping,
    selectAllDisplayedMeds: () => {
      setSelectedMedIds(new Set(displayList.map((m) => m.id)));
      setDeselectedIds(new Set());
    },
    deselectAllDisplayedMeds: () => {
      setSelectedMedIds(new Set());
      setDeselectedIds(new Set(displayList.map((m) => m.id)));
    },
    restoreAllMedicationsToShopping: () => setRemovedFromShoppingIds(new Set()),
  };
}
