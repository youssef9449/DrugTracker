import { useMemo, useState, useEffect } from 'react';
import type { Medication, PharmacySettings } from '../types';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  calculateMedicationOrderQuantity,
  buildWhatsAppUrl,
  type OrderItem,
} from '../utils/whatsapp';
import { shoppingRequestedPills } from '../utils/pharmacyShoppingCalculations';
import type { CustomOrderQuantities, OrderUnit, QuantityMode } from '../utils/pharmacyShoppingCalculations';

export interface UsePharmacyShoppingWhatsAppOptions {
  medications: Medication[];
  activeOrderItems: OrderItem[];
  quantityModes: Record<string, QuantityMode>;
  customOrderQuantities: CustomOrderQuantities;
  orderUnits: Record<string, OrderUnit[]>;
  getDurationDays: (medication: Medication) => number;
  getOrderBreakdown: (medication: Medication, suggestedPills: number) => { unit: OrderUnit; quantity: number }[];
  settings: PharmacySettings;
  onUpdateSettings: (settings: PharmacySettings) => void;
  showToast: (message: string) => void;
  onRegisterBackHandler?: (id: string, close: () => void, priority?: number) => () => void | undefined;
}

export function usePharmacyShoppingWhatsApp({
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
}: UsePharmacyShoppingWhatsAppOptions) {
  const pharmacies = settings.pharmacies || [];
  const selectedPharmacy = pharmacies.find((pharmacy) => pharmacy.id === settings.selectedPharmacyId)
    || pharmacies[0];
  const whatsappContacts = useMemo(() => settings.whatsappContacts ?? [], [settings.whatsappContacts]);
  const whatsappAddresses = useMemo(() => settings.whatsappAddresses ?? [], [settings.whatsappAddresses]);
  const selectedWhatsappContactIds = settings.selectedWhatsappContactIds ?? whatsappContacts.map((contact) => contact.id);
  const selectedWhatsappAddressIds = settings.selectedWhatsappAddressIds ?? whatsappAddresses.map((item) => item.id);
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
  }, [activeOrderItems, medications, quantityModes, customOrderQuantities, orderUnits, getDurationDays, getOrderBreakdown]);
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
    pharmacies,
    selectedPharmacy,
    whatsappContacts,
    whatsappAddresses,
    selectedWhatsappContactIds,
    selectedWhatsappAddressIds,
    orderItemsForMessage,
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
  };
}
