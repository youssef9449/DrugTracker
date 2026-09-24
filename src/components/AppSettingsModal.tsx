import { useState, useEffect, useMemo, type FC, type FormEvent } from 'react';
import type { ExactAlarmPermission } from '../utils/exactAlarm';
import {
  X,
  Settings,
  Phone,
  Check,
} from 'lucide-react';
import { Medication, PharmacySettings } from '../types';
import { AppPreferencesSection } from './settings/AppPreferencesSection';
import { NotificationSettingsSection } from './settings/NotificationSettingsSection';
import { Modal } from './ui/Modal';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  calculateMedicationOrderQuantity,
  OrderItem,
  buildWhatsAppUrl,
} from '../utils/whatsapp';
import { TOAST_MESSAGES } from '../constants/uiStrings';
import { ensureNotificationCapability } from '../hooks/ensureNotificationCapability';
import { PharmacySettingsSection } from './settings/PharmacySettingsSection';
export interface AppSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode?: 'all' | 'pharmacy';
  settings: PharmacySettings;
  medications: Medication[];
  activeOrderItems?: OrderItem[];
  onSaveSettings: (newSettings: PharmacySettings) => void;
  soundEnabled: boolean;
  notificationsEnabled?: boolean;
  criticalStockAlertsEnabled?: boolean;
  onSendTestNotification?: () => void;
  autoDeductEnabled?: boolean;
  /**
   * Apply app preference toggles only when the user confirms with حفظ الإعدادات.
   * Closing the modal without save discards draft changes.
   */
  onApplyAppPreferences?: (prefs: {
    soundEnabled: boolean;
    notificationsEnabled: boolean;
    criticalStockAlertsEnabled: boolean;
    autoDeductEnabled: boolean;
  }) => void | Promise<void>;
  /** Whether exact-alarm permission (SCHEDULE_EXACT_ALARM) is granted
   *  on Android 12+. When false, dose reminders CANNOT be guaranteed
   *  to fire on time — the UI shows a warning + a button to open the
   *  Android exact-alarm settings. */
  exactAlarmPermission?: ExactAlarmPermission | null;
  /** Open the Android settings screen to grant exact-alarm permission. */
  onOpenExactAlarmSettings?: () => void;
  /**
   * Optional toast for permission-denial feedback when turning notification
   * toggles ON. Same message as the home notification toggle.
   */
  showToast?: (message: string) => void;
}
export const AppSettingsModal: FC<AppSettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  medications,
  activeOrderItems,
  onSaveSettings,
  soundEnabled,
  notificationsEnabled = false,
  criticalStockAlertsEnabled = false,
  onSendTestNotification,
  autoDeductEnabled = true,
  onApplyAppPreferences,
  exactAlarmPermission = null,
  onOpenExactAlarmSettings,
  showToast,
  mode = 'all',
}) => {
  const isPharmacyOnly = mode === 'pharmacy';
  // Current pharmacy / contact / address identity comes only from the
  // pharmacies + whatsappContacts + whatsappAddresses collections.
  const selectedPharmacy =
    (settings.pharmacies ?? []).find((p) => p.id === settings.selectedPharmacyId) ??
    (settings.pharmacies ?? [])[0];
  const pharmacyPhone = selectedPharmacy?.phone ?? '';
  const pharmacyName = selectedPharmacy?.name ?? '';
  const customerCode = selectedPharmacy?.customerCode ?? '';
  const selectedContactIds = settings.selectedWhatsappContactIds ?? [];
  const selectedAddressIds = settings.selectedWhatsappAddressIds ?? [];
  const selectedContact =
    (settings.whatsappContacts ?? []).find((c) => selectedContactIds.includes(c.id)) ??
    (settings.whatsappContacts ?? [])[0];
  const selectedAddress =
    (settings.whatsappAddresses ?? []).find((a) => selectedAddressIds.includes(a.id)) ??
    (settings.whatsappAddresses ?? [])[0];
  const address = selectedAddress?.address ?? '';
  const contactPhone = selectedContact?.phone ?? '';
  // App preference drafts — committed only on حفظ الإعدادات.
  const [draftSound, setDraftSound] = useState(soundEnabled);
  const [draftNotifications, setDraftNotifications] = useState(notificationsEnabled);
  const [draftCritical, setDraftCritical] = useState(criticalStockAlertsEnabled);
  const [draftAutoDeduct, setDraftAutoDeduct] = useState(autoDeductEnabled);
  /**
   * Canonical notification-permission request for settings toggles.
   * Shared by dose-reminder and critical-stock draft toggles (#473).
   * Does not mutate draft state; callers flip only on success.
   */

  /**
   * OFF → ON for phone notifications: require OS notification permission
   * (same flow as App.handleToggleNotifications). Do not flip draft to true
   * on denial/error. ON → OFF is immediate.
   */
  const handleDraftNotificationsToggle = async () => {
    if (draftNotifications) {
      setDraftNotifications(false);
      return;
    }
    const pushAllowed = await ensureNotificationCapability('notifications').then((r) => r.allowed);
    if (!pushAllowed) {
      showToast?.(TOAST_MESSAGES.notificationsPermissionDenied);
      return;
    }
    setDraftNotifications(true);
  };

  /**
   * OFF → ON for critical-stock alerts: require OS notification permission.
   * Independent of dose-reminder draft — never flips draftNotifications.
   */
  const handleDraftCriticalToggle = async () => {
    if (draftCritical) {
      setDraftCritical(false);
      return;
    }
    const pushAllowed = await ensureNotificationCapability('critical').then((r) => r.allowed);
    if (!pushAllowed) {
      showToast?.(TOAST_MESSAGES.notificationsPermissionDenied);
      return;
    }
    setDraftCritical(true);
  };
  // Synchronize state whenever modal opens. Intentionally only dep [isOpen]
  // — if the parent passes a new settings object reference while the modal
  // is already open, we must NOT reset the form (that would blow away
  // in-progress edits). The latest settings is read from the closure at
  // the moment the modal opens.
  useEffect(() => {
    if (isOpen) {
      // Reset preference drafts from committed parent state on open.
      setDraftSound(soundEnabled);
      setDraftNotifications(notificationsEnabled);
      setDraftCritical(criticalStockAlertsEnabled);
      setDraftAutoDeduct(autoDeductEnabled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const formattedPhone = cleanPhoneNumber(pharmacyPhone);
  // #111: extracted from an inline IIFE — the WhatsApp order-message
  // preview computations. Memoized so they don't recompute on every
  // keystroke in unrelated form fields. Must be before the `if (!isOpen)`
  // early return (rules-of-hooks).
  const { previewMsg, waUrl, appUrl } = useMemo(() => {
    const orderItemsForMessage: OrderItem[] =
      activeOrderItems && activeOrderItems.length > 0
        ? activeOrderItems
        : medications.map((m) => {
            const { quantity } = calculateMedicationOrderQuantity(
              m,
              settings.defaultDurationDays
            );
            return {
              name: m.name,
              quantity,
              unit: m.unit,
              stripsPerBox: m.stripsPerBox,
              pillsPerStrip: m.pillsPerStrip,
              packageSize: m.packageSize,
            };
          });
    const msg = generatePharmacyOrderMessage(
      orderItemsForMessage,
      customerCode,
      address,
      contactPhone
    );
    return {
      previewMsg: msg,
      waUrl: buildWhatsAppUrl(pharmacyPhone, msg),
      appUrl: buildWhatsAppUrl(pharmacyPhone, msg, 'app'),
    };
  }, [
    activeOrderItems,
    medications,
    settings.defaultDurationDays,
    customerCode,
    address,
    contactPhone,
    pharmacyPhone,
  ]);
  if (!isOpen) return null;
  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    onSaveSettings({
      defaultDurationDays: settings.defaultDurationDays,
      pharmacies: settings.pharmacies ?? [],
      selectedPharmacyId: settings.selectedPharmacyId ?? '',
      whatsappContacts: settings.whatsappContacts ?? [],
      whatsappAddresses: settings.whatsappAddresses ?? [],
      selectedWhatsappContactIds: settings.selectedWhatsappContactIds ?? [],
      selectedWhatsappAddressIds: settings.selectedWhatsappAddressIds ?? [],
    });
    // Commit preference drafts only on explicit Save (not on close / dismiss).
    if (!isPharmacyOnly && onApplyAppPreferences) {
      await onApplyAppPreferences({
        soundEnabled: draftSound,
        notificationsEnabled: draftNotifications,
        criticalStockAlertsEnabled: draftCritical,
        autoDeductEnabled: draftAutoDeduct,
      });
    }
    onClose();
  };
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      label={isPharmacyOnly ? 'إعدادات الصيدلية' : 'إعدادات التطبيق'}
    >
      <div
        className={
          'w-full sm:max-w-lg bg-white rounded-t-[28px] sm:rounded-[28px] shadow-xl border'
        className={
          'w-full sm:max-w-lg bg-white rounded-t-[28px] sm:rounded-[28px] shadow-xl border'
          + 'border-slate-200/80 overflow-hidden max-h-[92vh] flex flex-col animate-in'
          + 'slide-in-from-bottom duration-200'
        }
        dir="rtl"
      >
        {/* Header */}
        <div className="px-5 py-4 bg-teal-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-teal-700/90 flex items-center justify-center">
              {isPharmacyOnly ? (
                <Phone className="w-5 h-5 text-teal-100" />
              ) : (
                <Settings className="w-5 h-5 text-teal-100" />
              )}
            </div>
            <div>
              <h3 className="font-bold text-base">
                {isPharmacyOnly ? 'إعدادات الصيدلية' : 'إعدادات التطبيق'}
              </h3>
              <p className="text-[11px] text-teal-200">
                {isPharmacyOnly
                  ? 'تحديد رقم واتساب الصيدلية، كود العميل، وبيانات التوصيل'
                  : 'تخصيص الخصم التلقائي والإشعارات'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={
              'w-10 h-10 rounded-full text-teal-200 hover:text-white '
              + 'hover:bg-teal-700/80 transition flex items-center justify-center cursor-pointer'
            }
            title="إغلاق"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {/* Form Body */}
        <form onSubmit={handleSave} className="p-5 overflow-y-auto space-y-4 flex-1">
          {!isPharmacyOnly && (
            <>
              <AppPreferencesSection
                draftAutoDeduct={draftAutoDeduct}
                setDraftAutoDeduct={setDraftAutoDeduct}
                draftSound={draftSound}
                setDraftSound={setDraftSound}
              />
              <NotificationSettingsSection
                draftNotifications={draftNotifications}
                draftCritical={draftCritical}
                onToggleNotifications={() => { void handleDraftNotificationsToggle(); }}
                onToggleCritical={() => { void handleDraftCriticalToggle(); }}
                exactAlarmPermission={exactAlarmPermission}
                onOpenExactAlarmSettings={onOpenExactAlarmSettings}
                onSendTestNotification={onSendTestNotification}
              />
            </>
          )}
          {isPharmacyOnly && (
            <PharmacySettingsSection
              pharmacyPhone={pharmacyPhone}
              formattedPhone={formattedPhone}
              customerCode={customerCode}
              pharmacyName={pharmacyName}
              address={address}
              contactPhone={contactPhone}
              previewMsg={previewMsg}
              waUrl={waUrl}
              appUrl={appUrl}
              hasActiveOrderItems={Boolean(activeOrderItems && activeOrderItems.length > 0)}
            />
          )}
          {/* Submit Button */}
          <div className="pt-2">
            <button
              type="submit"
              className={
                'w-full h-11 px-6 bg-teal-700 hover:bg-teal-800 active:scale-98 '
                + 'text-white rounded-full font-semibold text-sm flex items-center '
                + 'justify-center gap-2 shadow-2xs transition cursor-pointer'
              }
            >
              <Check className="w-4 h-4" />
              <span>{isPharmacyOnly ? 'حفظ إعدادات الصيدلية' : 'حفظ الإعدادات'}</span>
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};