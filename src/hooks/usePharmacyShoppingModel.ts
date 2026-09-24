import { useState, useMemo, useCallback } from 'react';
import type { Medication, PharmacySettings } from '../types';
import { usePharmacyShoppingSelection } from './usePharmacyShoppingSelection';
import { usePharmacyShoppingWhatsApp } from './usePharmacyShoppingWhatsApp';
import { calculateMedicationOrderQuantity, type OrderItem } from '../utils/whatsapp';
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
  const selection = usePharmacyShoppingSelection({ medications });
  const {
    showAllForPlanning,
    setShowAllForPlanning,
    displayList,
    selectedMedIds,
    handleToggleSelect,
    handleRemoveFromShopping,
    selectAllDisplayedMeds,
    deselectAllDisplayedMeds,
    restoreAllMedicationsToShopping,
  } = selection;
  const [orderUnits, setOrderUnits] = useState<Record<string, OrderUnit[]>>({});
  const getMedicationPeriod = (med: Medication): MedicationPeriod =>
    resolveMedicationPeriod(medicationPeriods, med, settings.defaultDurationDays);
  const getDurationDays = useCallback(
    (med: Medication): number =>
      resolveDurationDays(medicationPeriods, med, settings.defaultDurationDays),
    [medicationPeriods, settings.defaultDurationDays]
  );
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
  const getOrderBreakdown = useCallback(
    (med: Medication, suggestedPills: number): { unit: OrderUnit; quantity: number }[] =>
      resolveOrderBreakdown(customOrderQuantities, orderUnits, quantityModes, med, suggestedPills),
    [customOrderQuantities, orderUnits, quantityModes]
  );
  const getAvailableUnits = (med: Medication): OrderUnit[] => getShoppingAvailableUnits(med);

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
  }, [displayList, selectedMedIds, medicationPeriods, quantityModes, customOrderQuantities, orderUnits, settings.defaultDurationDays, getDurationDays, getOrderBreakdown]);
  const {
    pharmacies,
    selectedPharmacy,
    whatsappContacts,
    whatsappAddresses,
    selectedWhatsappContactIds,
    selectedWhatsappAddressIds,
    currentWhatsAppMessage,
    isSendModalOpen,
    setIsSendModalOpen,
    hasPharmacyPhone,
    displayPhone,
    selectedCount,
    targetWaUrl,
    handleSendToWhatsApp,
    toggleWhatsappContact,
    toggleWhatsappAddress,
  } = usePharmacyShoppingWhatsApp({
    medications,
    activeOrderItems,
    quantityModes,
    customOrderQuantities,
    orderUnits,
    getDurationDays,
    getOrderBreakdown,
    settings,
    onUpdateSettings,
    showToast,
    onRegisterBackHandler,
  });

  return {
    pharmacies, selectedPharmacy, whatsappContacts, whatsappAddresses,
    selectedWhatsappContactIds, selectedWhatsappAddressIds, showAllForPlanning,
    setShowAllForPlanning, displayList, selectedMedIds,
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
    selectAllDisplayedMeds,
    deselectAllDisplayedMeds,
    restoreAllMedicationsToShopping,
  };
}
