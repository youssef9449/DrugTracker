import { useState, useMemo, useEffect } from 'react';
import type { Medication, PharmacySettings } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import { cleanPhoneNumber, generatePharmacyOrderMessage, calculateMedicationOrderQuantity, buildWhatsAppUrl, type OrderItem } from '../utils/whatsapp';
import {
  getShoppingAvailableUnits, getShoppingUnitSize,
  shoppingRequestedPills, getMedicationPeriod as resolveMedicationPeriod,
  getDurationDays as resolveDurationDays, getQuantityMode as resolveQuantityMode,
  getSelectedUnits as resolveSelectedUnits, getUnitQuantity as resolveUnitQuantity,
  getCustomQuantityInputValue as resolveCustomQuantityInputValue,
  getRequestedPills as resolveRequestedPills, getOrderBreakdown as resolveOrderBreakdown, unitLabel,
  type OrderUnit, type CustomOrderQuantities, type PeriodUnit, type MedicationPeriod, type QuantityMode,
} from '../utils/pharmacyShoppingCalculations';

export interface UsePharmacyShoppingModelOptions {
  medications: Medication[];
  settings: PharmacySettings;
  onUpdateSettings: (newSettings: PharmacySettings) => void;
  showToast: (message: string) => void;
  onRegisterBackHandler?: (id: string, close: () => void, priority?: number) => () => void;
}

export function usePharmacyShoppingModel({
  medications,
  settings,
  onUpdateSettings,
  showToast,
  onRegisterBackHandler,
}: UsePharmacyShoppingModelOptions) {
  const [medicationPeriods, setMedicationPeriods] = useState<Record<string, MedicationPeriod>>({});
  const [quantityModes, setQuantityModes] = useState<Record<string, QuantityMode>>({});
  const [customOrderQuantities, setCustomOrderQuantities] = useState<CustomOrderQuantities>({});
  const pharmacies = settings.pharmacies || [];
  const selectedPharmacy = pharmacies.find((pharmacy) => pharmacy.id === settings.selectedPharmacyId)
    || pharmacies[0];
  const whatsappContacts = useMemo(
    () => settings.whatsappContacts ?? [],
    [settings.whatsappContacts]
  );
  const whatsappAddresses = useMemo(
    () => settings.whatsappAddresses ?? [],
    [settings.whatsappAddresses]
  );
  const selectedWhatsappContactIds = settings.selectedWhatsappContactIds
    ?? whatsappContacts.map((contact) => contact.id);
  const selectedWhatsappAddressIds = settings.selectedWhatsappAddressIds
    ?? whatsappAddresses.map((item) => item.id);
  const [showAllForPlanning, setShowAllForPlanning] = useState(false);
  // Multiple order units may be selected together in "كمية محددة".
  const [orderUnits, setOrderUnits] = useState<Record<string, OrderUnit[]>>({});
  const [removedFromShoppingIds, setRemovedFromShoppingIds] = useState<Set<string>>(new Set());
  // #20: track meds the user explicitly DESELECTED so the
  // reconciliation effect doesn't silently re-select them when
  // `displayList` changes. Cleared for a med when it leaves
  // `displayList` (so it starts fresh if it returns).
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set());
  const getMedicationPeriod = (med: Medication): MedicationPeriod =>
    resolveMedicationPeriod(medicationPeriods, med, settings.defaultDurationDays);
  const getDurationDays = (med: Medication): number =>
    resolveDurationDays(medicationPeriods, med, settings.defaultDurationDays);
  const getQuantityMode = (med: Medication): QuantityMode =>
    resolveQuantityMode(quantityModes, med);
  const getSelectedUnits = (med: Medication): OrderUnit[] =>
    resolveSelectedUnits(orderUnits, med);
  const getUnitQuantity = (med: Medication, unit: OrderUnit, suggestedPills: number): number =>
    resolveUnitQuantity(customOrderQuantities, quantityModes, med, unit, suggestedPills);
  const getCustomQuantityInputValue = (med: Medication, unit: OrderUnit, suggestedPills: number): number | '' =>
    resolveCustomQuantityInputValue(customOrderQuantities, med, unit, suggestedPills);
  const getRequestedPills = (med: Medication, suggestedPills: number): number =>
    resolveRequestedPills(quantityModes, customOrderQuantities, orderUnits, med, suggestedPills);
  const handleToggleQuantityMode = (med: Medication, mode: QuantityMode, suggestedPills: number) => {
    setQuantityModes((prev) => ({ ...prev, [med.id]: mode }));
    if (mode !== 'custom') return;
    const selectedUnits = getSelectedUnits(med);
    setCustomOrderQuantities((prev) => {
      const current = prev[med.id] || {};
      const next = { ...current };
      for (const unit of selectedUnits) {
        if (next[unit] === undefined) {
          next[unit] = Math.max(1, Math.ceil(
            suggestedPills / getShoppingUnitSize(med, unit)
          ));
        }
      }
      return {
        ...prev,
        [med.id]: next,
      };
    });
  };

  const handleToggleOrderUnit = (med: Medication, unit: OrderUnit, _suggestedPills: number) => {
    const selected = getSelectedUnits(med);
    if (getQuantityMode(med) !== 'custom') {
      setOrderUnits((prev) => ({
        ...prev,
        [med.id]: [unit],
      }));
      return;
    }
    if (selected.includes(unit)) {
      if (selected.length <= 1) return;
      setOrderUnits((prev) => ({
        ...prev,
        [med.id]: selected.filter((item) => item !== unit),
      }));
      return;
    }
    setOrderUnits((prev) => ({
      ...prev,
      [med.id]: [...selected, unit],
    }));
    setCustomOrderQuantities((prev) => ({
      ...prev,
      [med.id]: {
        ...(prev[med.id] || {}),
        [unit]: 1,
      },
    }));
  };

  const handleCustomQuantityChange = (med: Medication, unit: OrderUnit, raw: string) => {
    if (raw === '') {
      setCustomOrderQuantities((prev) => ({
        ...prev,
        [med.id]: {
          ...(prev[med.id] || {}),
          [unit]: '',
        },
      }));
      return;
    }
    const parsed = parseInt(raw, 10);
    setCustomOrderQuantities((prev) => ({
      ...prev,
      [med.id]: {
        ...(prev[med.id] || {}),
        [unit]: Math.max(1, Number.isFinite(parsed) ? parsed : 1),
      },
    }));
  };
  const getOrderBreakdown = (med: Medication, suggestedPills: number): { unit: OrderUnit; quantity: number }[] =>
    resolveOrderBreakdown(customOrderQuantities, orderUnits, quantityModes, med, suggestedPills);
  const getAvailableUnits = (med: Medication): OrderUnit[] => getShoppingAvailableUnits(med);

  const urgentMeds = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    });
  }, [medications]);
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
  const handleMedicationPeriodChange = (medId: string, field: keyof MedicationPeriod, value: string) => {
    const med = medications.find((item) => item.id === medId);
    if (!med) return;
    const currentPeriod = getMedicationPeriod(med);
    if (field === 'unit') {
      const nextUnit = value as PeriodUnit;
      const currentValue = currentPeriod.value === '' ? 1 : currentPeriod.value;
      const currentDays = currentValue * (currentPeriod.unit === 'month' ? 30 : 1);
      const nextValue = nextUnit === 'month'
        ? Math.max(1, Math.ceil(currentDays / 30))
        : Math.max(1, currentDays);
      setMedicationPeriods((prev) => ({
        ...prev,
        [medId]: {
          value: nextValue,
          unit: nextUnit,
        },
      }));
      return;
    }
    const nextValue = value === '' ? '' : Math.max(1, parseInt(value, 10) || 1);
    setMedicationPeriods((prev) => ({
      ...prev,
      [medId]: {
        ...currentPeriod,
        value: nextValue,
      },
    }));
  };
  const getRequestedAmount = (med: Medication) =>
    calculateMedicationOrderQuantity(med, getDurationDays(med));
  const activeOrderItems = useMemo((): OrderItem[] => {
    return displayList
      .filter((med) => selectedMedIds.has(med.id))
      .map((med) => {
        const { quantity: suggestedPills } = calculateMedicationOrderQuantity(
          med,
          getDurationDays(med)
        );
        return {
          name: med.name,
          quantity: shoppingRequestedPills(
            med,
            suggestedPills,
            quantityModes,
            customOrderQuantities,
            orderUnits
          ),
          unit: med.unit,
          stripsPerBox: med.stripsPerBox,
          pillsPerStrip: med.pillsPerStrip,
          packageSize: med.packageSize,
          orderBreakdown: getOrderBreakdown(med, suggestedPills),
        };
      });
  }, [displayList, selectedMedIds, medicationPeriods, quantityModes, customOrderQuantities, orderUnits, settings.defaultDurationDays]);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  useEffect(() => {
    if (!isSendModalOpen || !onRegisterBackHandler) return;
    return onRegisterBackHandler('shopping-send-order', () => setIsSendModalOpen(false), 100);
  }, [isSendModalOpen, onRegisterBackHandler]);
  const orderItemsForMessage = useMemo((): OrderItem[] => {
    if (activeOrderItems.length > 0) return activeOrderItems;
    return medications.map((med) => {
      const { quantity: suggestedPills } = calculateMedicationOrderQuantity(
        med,
        getDurationDays(med)
      );
      return {
        name: med.name,
        quantity: shoppingRequestedPills(
          med,
          suggestedPills,
          quantityModes,
          customOrderQuantities,
          orderUnits
        ),
        unit: med.unit,
        stripsPerBox: med.stripsPerBox,
        pillsPerStrip: med.pillsPerStrip,
        packageSize: med.packageSize,
        orderBreakdown: getOrderBreakdown(med, suggestedPills),
      };
    });
  }, [activeOrderItems, medications, medicationPeriods, quantityModes, customOrderQuantities, orderUnits, settings.defaultDurationDays]);
  const currentWhatsAppMessage = useMemo(() => {
    return generatePharmacyOrderMessage(
      orderItemsForMessage,
      selectedPharmacy?.customerCode || '',
      '',
      '',
      whatsappAddresses
        .filter((item) => selectedWhatsappAddressIds.includes(item.id))
        .map((item) => item.address),
      whatsappContacts
        .filter((contact) => selectedWhatsappContactIds.includes(contact.id))
        .map((contact) => contact.phone)
    );
  }, [orderItemsForMessage, selectedPharmacy?.customerCode, whatsappAddresses, whatsappContacts, selectedWhatsappAddressIds, selectedWhatsappContactIds]);
  const toggleWhatsappContact = (id: string) => {
    const nextIds = selectedWhatsappContactIds.includes(id)
      ? selectedWhatsappContactIds.filter((selectedId) => selectedId !== id)
      : [...selectedWhatsappContactIds, id];
    onUpdateSettings({
      ...settings,
      whatsappContacts,
      whatsappAddresses,
      selectedWhatsappContactIds: nextIds,
      selectedWhatsappAddressIds,
    });
  };
  const toggleWhatsappAddress = (id: string) => {
    const nextIds = selectedWhatsappAddressIds.includes(id)
      ? selectedWhatsappAddressIds.filter((selectedId) => selectedId !== id)
      : [...selectedWhatsappAddressIds, id];
    onUpdateSettings({
      ...settings,
      whatsappContacts,
      whatsappAddresses,
      selectedWhatsappContactIds,
      selectedWhatsappAddressIds: nextIds,
    });
  };
  const hasPharmacyPhone = Boolean(selectedPharmacy?.phone?.trim());
  const displayPhone = selectedPharmacy?.phone ? cleanPhoneNumber(selectedPharmacy.phone) : '';
  const selectedCount = activeOrderItems.length;
  const targetWaUrl = useMemo(() => {
    return buildWhatsAppUrl(selectedPharmacy?.phone || '', currentWhatsAppMessage);
  }, [selectedPharmacy?.phone, currentWhatsAppMessage]);
  const handleSendToWhatsApp = () => {
    if (selectedCount === 0) {
      showToast('يرجى تحديد دواء واحد على الأقل لإرسال الطلب.');
      return;
    }
    if (!selectedPharmacy?.phone?.trim()) {
      setIsSendModalOpen(true);
      showToast('أضف صيدلية من تبويب الصيدليات أولًا.');
      return;
    }
    // Let the user choose the destination pharmacy in the confirmation modal
    // before opening WhatsApp.
    setIsSendModalOpen(true);
    showToast('اختر الصيدلية ثم افتح واتساب لإرسال الطلب.');
  };

  return {
    pharmacies, selectedPharmacy, whatsappContacts, whatsappAddresses,
    selectedWhatsappContactIds, selectedWhatsappAddressIds, showAllForPlanning,
    setShowAllForPlanning, removedFromShoppingIds, displayList, selectedMedIds,
    activeOrderItems, currentWhatsAppMessage, isSendModalOpen, setIsSendModalOpen,
    hasPharmacyPhone, displayPhone, selectedCount, targetWaUrl,
    handleToggleSelect, handleRemoveFromShopping,
    getMedicationPeriod,
    getQuantityMode,
    getAvailableUnits,
    getSelectedUnits,
    getUnitQuantity,
    getCustomQuantityInputValue,
    getOrderBreakdown,
    getRequestedPills,
    unitLabel, getRequestedAmount, handleMedicationPeriodChange, handleToggleQuantityMode,
    handleToggleOrderUnit, handleCustomQuantityChange, toggleWhatsappContact,
    toggleWhatsappAddress, handleSendToWhatsApp,
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
