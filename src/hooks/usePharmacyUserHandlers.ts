import type { Dispatch, SetStateAction } from 'react';
import type { PharmacySettings, Pharmacy, UserContact, UserAddress } from '../types';
import { playSuccessChime } from '../utils/sound';

/**
 * Pharmacy and user contact/address CRUD handlers from App.tsx.
 * Operates only on the current pharmacies / whatsappContacts / whatsappAddresses arrays.
 */
export function usePharmacyUserHandlers(opts: {
  soundEnabled: boolean;
  settingsModalMode: 'all' | 'pharmacy';
  pharmacySettings: PharmacySettings;
  setPharmacySettings: Dispatch<SetStateAction<PharmacySettings>>;
  showToast: (message: string) => void;
}) {
  const { soundEnabled, settingsModalMode, pharmacySettings, setPharmacySettings, showToast } = opts;

  const handleSavePharmacySettings = (newSettings: PharmacySettings) => {
    setPharmacySettings(newSettings);
    showToast(
      settingsModalMode === 'pharmacy'
        ? 'تم حفظ إعدادات الصيدلية بنجاح!'
        : 'تم حفظ الإعدادات بنجاح!'
    );
    if (soundEnabled) playSuccessChime();
  };

  const handleSavePharmacy = (pharmacy: Pharmacy) => {
    setPharmacySettings((prev) => {
      const pharmacies = prev.pharmacies || [];
      const exists = pharmacies.some((item) => item.id === pharmacy.id);
      return {
        ...prev,
        pharmacies: exists
          ? pharmacies.map((item) => (item.id === pharmacy.id ? pharmacy : item))
          : [...pharmacies, pharmacy],
        selectedPharmacyId: prev.selectedPharmacyId || pharmacy.id,
      };
    });
  };

  const handleDeletePharmacy = (id: string) => {
    setPharmacySettings((prev) => {
      const pharmacies = (prev.pharmacies || []).filter((item) => item.id !== id);
      return {
        ...prev,
        pharmacies,
        selectedPharmacyId:
          prev.selectedPharmacyId === id ? pharmacies[0]?.id || '' : prev.selectedPharmacyId,
      };
    });
    showToast('تم حذف الصيدلية.');
  };

  const userContacts: UserContact[] = pharmacySettings.whatsappContacts ?? [];
  const userAddresses: UserAddress[] = pharmacySettings.whatsappAddresses ?? [];

  const handleSaveUserContact = (contact: UserContact) => {
    setPharmacySettings((prev) => {
      const contacts = prev.whatsappContacts ?? [];
      const exists = contacts.some((item) => item.id === contact.id);
      return {
        ...prev,
        whatsappContacts: exists
          ? contacts.map((item) => (item.id === contact.id ? contact : item))
          : [...contacts, contact],
      };
    });
  };

  const handleDeleteUserContact = (id: string) => {
    setPharmacySettings((prev) => ({
      ...prev,
      whatsappContacts: (prev.whatsappContacts || []).filter((item) => item.id !== id),
      selectedWhatsappContactIds: (prev.selectedWhatsappContactIds || []).filter(
        (item) => item !== id
      ),
    }));
    showToast('تم حذف رقم التليفون.');
  };

  const handleSaveUserAddress = (address: UserAddress) => {
    setPharmacySettings((prev) => {
      const addresses = prev.whatsappAddresses ?? [];
      const exists = addresses.some((item) => item.id === address.id);
      return {
        ...prev,
        whatsappAddresses: exists
          ? addresses.map((item) => (item.id === address.id ? address : item))
          : [...addresses, address],
      };
    });
  };

  const handleDeleteUserAddress = (id: string) => {
    setPharmacySettings((prev) => ({
      ...prev,
      whatsappAddresses: (prev.whatsappAddresses || []).filter((item) => item.id !== id),
      selectedWhatsappAddressIds: (prev.selectedWhatsappAddressIds || []).filter(
        (item) => item !== id
      ),
    }));
    showToast('تم حذف العنوان.');
  };

  return {
    handleSavePharmacySettings,
    handleSavePharmacy,
    handleDeletePharmacy,
    handleSaveUserContact,
    handleDeleteUserContact,
    handleSaveUserAddress,
    handleDeleteUserAddress,
    userContacts,
    userAddresses,
  };
}
