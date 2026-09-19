import { useState, useEffect, useMemo, type FC, type FormEvent } from 'react';
import {
  X,
  Settings,
  Phone,
  UserCheck,
  Check,
  CheckCircle2,
  MessageSquare,
  MessageCircle,
  Volume2,
  VolumeX,
  Bell,
  BellOff,
  AlertTriangle,
  Zap,
  ZapOff,
} from 'lucide-react';
import { Medication, PharmacySettings } from '../types';
import { Toggle } from './ui/Toggle';
import { Modal } from './ui/Modal';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  calculateMedicationOrderQuantity,
  OrderItem,
  buildWhatsAppUrl,
} from '../utils/whatsapp';


import { normalizeArabicDigits } from '../utils/whatsapp';
import {
  getNotificationPermission,
  requestNotificationPermission,
} from '../utils/notifications';
import { TOAST_MESSAGES } from '../constants/uiStrings';

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
  onToggleAutoDeduct?: () => void;
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
  exactAlarmEnabled?: boolean | null;
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
  notificationsEnabled = true,
  criticalStockAlertsEnabled = true,
  onSendTestNotification,
  autoDeductEnabled = true,
  onApplyAppPreferences,
  exactAlarmEnabled = null,
  onOpenExactAlarmSettings,
  showToast,
  mode = 'all',
}) => {
  const isPharmacyOnly = mode === 'pharmacy';
  const [pharmacyPhone, setPharmacyPhone] = useState(settings.pharmacyPhone || '');
  const [pharmacyName, setPharmacyName] = useState(
    (settings.pharmacyName === 'الصيدلية' ? '' : settings.pharmacyName) || ''
  );
  const [customerCode, setCustomerCode] = useState(
    (settings.customerCode === '14739' ? '' : settings.customerCode) || ''
  );
  const [address, setAddress] = useState(settings.address || '');
  const [contactPhone, setContactPhone] = useState(settings.contactPhone || '');

  // App preference drafts — committed only on حفظ الإعدادات.
  const [draftSound, setDraftSound] = useState(soundEnabled);
  const [draftNotifications, setDraftNotifications] = useState(notificationsEnabled);
  const [draftCritical, setDraftCritical] = useState(criticalStockAlertsEnabled);
  const [draftAutoDeduct, setDraftAutoDeduct] = useState(autoDeductEnabled);

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
    let pushAllowed = false;
    try {
      const currentPerm = await getNotificationPermission();
      if (currentPerm === 'granted') {
        pushAllowed = true;
      } else if (currentPerm === 'default') {
        pushAllowed = await requestNotificationPermission();
      }
    } catch (err) {
      console.warn('[AppSettingsModal] Notification permission error:', err);
    }
    if (!pushAllowed) {
      showToast?.(TOAST_MESSAGES.notificationsPermissionDenied);
      return;
    }
    setDraftNotifications(true);
  };

  /**
   * OFF → ON for critical-stock alerts: require notification permission when
   * phone notifications are not already draft-on (matches home critical toggle).
   * On success also enables draftNotifications when it was off.
   */
  const handleDraftCriticalToggle = async () => {
    if (draftCritical) {
      setDraftCritical(false);
      return;
    }
    if (!draftNotifications) {
      let pushAllowed = false;
      try {
        const currentPerm = await getNotificationPermission();
        if (currentPerm === 'granted') {
          pushAllowed = true;
        } else if (currentPerm === 'default') {
          pushAllowed = await requestNotificationPermission();
        }
      } catch (err) {
        console.warn(
          '[AppSettingsModal] Notification permission error (critical toggle):',
          err
        );
      }
      if (!pushAllowed) {
        showToast?.(TOAST_MESSAGES.notificationsPermissionDenied);
        return;
      }
      setDraftNotifications(true);
    }
    setDraftCritical(true);
  };

  // Synchronize state whenever modal opens. Intentionally only dep [isOpen]
  // — if the parent passes a new settings object reference while the modal
  // is already open, we must NOT reset the form (that would blow away
  // in-progress edits). The latest settings is read from the closure at
  // the moment the modal opens (audit #93).
  useEffect(() => {
    if (isOpen) {
      setPharmacyPhone(settings.pharmacyPhone || '');
      setPharmacyName((settings.pharmacyName === 'الصيدلية' ? '' : settings.pharmacyName) || '');
      setCustomerCode((settings.customerCode === '14739' ? '' : settings.customerCode) || '');
      setAddress(settings.address || '');
      setContactPhone(settings.contactPhone || '');
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
              settings.defaultDurationDays,
              settings.customQuantities
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
    settings.customQuantities,
    customerCode,
    address,
    contactPhone,
    pharmacyPhone,
  ]);

  if (!isOpen) return null;

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    onSaveSettings({
      pharmacyPhone: isPharmacyOnly ? pharmacyPhone.trim() : settings.pharmacyPhone,
      pharmacyName: isPharmacyOnly ? pharmacyName.trim() : settings.pharmacyName,
      customerCode: isPharmacyOnly ? customerCode.trim() : settings.customerCode,
      // Preserve the duration/quantities managed by the shopping view.
      defaultDurationDays: settings.defaultDurationDays,
      customQuantities: settings.customQuantities,
      address: isPharmacyOnly ? address.trim() : settings.address,
      contactPhone: isPharmacyOnly ? contactPhone.trim() : settings.contactPhone,
      pharmacies: settings.pharmacies,
      selectedPharmacyId: settings.selectedPharmacyId,
      whatsappContacts: settings.whatsappContacts,
      whatsappAddresses: settings.whatsappAddresses,
      selectedWhatsappContactIds: settings.selectedWhatsappContactIds,
      selectedWhatsappAddressIds: settings.selectedWhatsappAddressIds,
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
        className="w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col animate-in slide-in-from-bottom duration-200"
        dir="rtl"
      >
        {/* Header */}
        <div className="px-5 py-4 bg-teal-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-teal-700 flex items-center justify-center">
              {isPharmacyOnly ? (
                <Phone className="w-4 h-4 text-teal-100" />
              ) : (
                <Settings className="w-4 h-4 text-teal-100" />
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
            className="p-1 rounded-full text-teal-200 hover:text-white hover:bg-teal-700 transition"
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
              {/* Auto Daily Deduction Section */}
              <div className="bg-teal-50/70 border border-teal-200/80 rounded-2xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        draftAutoDeduct ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {draftAutoDeduct ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-800">الخصم التلقائي للمخزون</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                            draftAutoDeduct ? 'bg-teal-200 text-teal-900' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {draftAutoDeduct ? 'مفعّل' : 'متوقف'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 leading-tight">
                        يُخصم تلقائياً عند ميعاد كل جرعة
                      </p>
                    </div>
                  </div>
                  <Toggle
                    checked={draftAutoDeduct}
                    onChange={() => setDraftAutoDeduct((v) => !v)}
                    label="تبديل الخصم التلقائي"
                  />
                </div>
                <p className="text-[10px] text-slate-500 leading-tight border-t border-teal-100/80 pt-2">
                  {draftAutoDeduct
                    ? 'عند التفعيل يُخصم عند ميعاد الجرعات ويُحدَّث الرصيد وموعد النفاذ.'
                    : 'عند الإيقاف يتوقف الخصم التلقائي ويبقى الرصيد ثابتاً.'}
                </p>
              </div>

              {/* Notifications & Alerts Management Section */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        draftNotifications ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {draftNotifications ? (
                        <Bell className="w-4 h-4 fill-amber-500" />
                      ) : (
                        <BellOff className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-800">التنبيهات وإشعارات الهاتف</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                            draftNotifications ? 'bg-amber-100 text-amber-900 border border-amber-300/50' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {draftNotifications ? 'مفعّلة' : 'متوقفة'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500">منبه مواعيد الجرعات وتنبيهات المخزون</p>
                    </div>
                  </div>
                  <Toggle
                    id="settings-toggle-notifications"
                    checked={draftNotifications}
                    onChange={() => { void handleDraftNotificationsToggle(); }}
                    label={
                      draftNotifications
                        ? 'التنبيهات مفعلة — انقر للإيقاف'
                        : 'التنبيهات متوقفة — انقر للتفعيل'
                    }
                    color="amber"
                  />
                </div>

                <hr className="border-slate-200" />

                {/* Critical Stock Alerts Toggle */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        draftCritical ? 'bg-rose-100 text-rose-600' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      <AlertTriangle
                        className={`w-4 h-4 ${
                          draftCritical ? 'fill-rose-500/30' : ''
                        }`}
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-800">تنبيهات النفاذ الحرج للمخزون</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                            draftCritical ? 'bg-rose-100 text-rose-800 border border-rose-300/50' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {draftCritical ? 'مفعّلة' : 'متوقفة'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        إشعار فوري عند اقتراب نفاد الدواء أو نفاذه (حسب إعداد كل دواء)
                      </p>
                    </div>
                  </div>
                                    <Toggle
                    id="settings-toggle-critical"
                    checked={draftCritical}
                    onChange={() => { void handleDraftCriticalToggle(); }}
                    label={
                      draftCritical
                        ? 'تنبيهات المخزون الحرج مفعلة — انقر للإيقاف'
                        : 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل'
                    }
                    color="rose"
                  />
                </div>

                {/* Test Notification Button */}
                {onSendTestNotification && (
                  <button
                    type="button"
                    onClick={onSendTestNotification}
                    className="w-full py-2 px-3 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300/80 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition active:scale-98 shadow-xs"
                  >
                    <Bell className="w-4 h-4 text-amber-600" />
                    <span>🔔 تجربة إشعار وتنبيه صوتي الآن (اختبار فوري)</span>
                  </button>
                )}

                {/* Exact-alarm permission warning (Android 12+) */}
                {draftNotifications && !exactAlarmEnabled && onOpenExactAlarmSettings && (
                  <div className="bg-rose-50 border border-rose-300/80 rounded-xl p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-rose-900 leading-relaxed">
                        <strong>تنبيه: المنبهات الدقيقة غير مفعّلة</strong>
                        <br />
                        لضمان وصول تذكير الجرعة في موعده بالضبط، اسمح للتطبيق باستخدام
                        المنبهات الدقيقة من إعدادات Android. بدون هذا الإذن قد يتأخر
                        التذكير دقائق أو ساعات.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onOpenExactAlarmSettings}
                      className="w-full py-2 px-3 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition active:scale-98 shadow-xs"
                    >
                      <Bell className="w-4 h-4" />
                      <span>السماح بالمنبهات الدقيقة (إعدادات Android)</span>
                    </button>
                  </div>
                )}

                {/* Exact-alarm granted indicator */}
                {draftNotifications && exactAlarmEnabled && (
                  <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span>المنبهات الدقيقة مفعّلة — تذكيرات الجرعات مضمونة في موعدها</span>
                  </div>
                )}
              </div>

              {/* Sound management section */}
              <div className="bg-teal-50/70 border border-teal-200/80 rounded-2xl p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {draftSound ? (
                      <Volume2 className="w-4 h-4 text-teal-600" />
                    ) : (
                      <VolumeX className="w-4 h-4 text-slate-400" />
                    )}
                    <span className="text-xs font-bold text-slate-700">تأثيرات صوتية في التطبيق</span>
                  </div>
                  <Toggle
                    checked={draftSound}
                    onChange={() => setDraftSound((v) => !v)}
                    label="تبديل التأثيرات الصوتية"
                  />
                </div>
              </div>
            </>
          )}

          {/* Pharmacy and WhatsApp Configuration Section */}
          {isPharmacyOnly && <div className="space-y-3 pt-1">
            {/* Pharmacy Phone Number */}
            <div className="bg-teal-50/70 border border-teal-200/80 rounded-2xl p-3.5 space-y-2">
              <label className="block text-xs font-bold text-teal-950 flex items-center gap-1.5">
                <Phone className="w-4 h-4 text-teal-700" />
                <span>رقم هاتف الصيدلية (واتساب) <span className="text-red-500">*</span></span>
              </label>
              <input
                type="tel"
                value={pharmacyPhone}
                onChange={(e) => setPharmacyPhone(e.target.value)}
                placeholder="مثال: 01012345678 أو 0123456789"
                className="w-full px-3.5 py-2.5 rounded-xl border border-teal-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
              <div className="text-[11px] text-teal-800 flex items-center justify-between">
                <span>سيتم إرسال الطلب لهذا الرقم مباشرة عبر واتساب.</span>
                {formattedPhone && (
                  <span className="font-mono text-teal-900 bg-teal-200/60 px-2 py-0.5 rounded-md">
                    +{formattedPhone}
                  </span>
                )}
              </div>
            </div>

            {/* Customer Code & Pharmacy Name */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Customer Code */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                  <UserCheck className="w-4 h-4 text-teal-600" />
                  <span>كود العميل في الصيدلية (اختياري)</span>
                </label>
                <input
                  type="text"
                  value={customerCode}
                  onChange={(e) => setCustomerCode(e.target.value)}
                  placeholder="اكتب كود العميل إن وجد (اختياري)"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
                {customerCode.trim() ? (
                  <span className="text-[10px] text-teal-700 font-medium mt-1 block">
                    يظهر في نهاية الرسالة: (كود العميل {customerCode.trim()})
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400 mt-1 block">
                    اختياري — لن يظهر سطر كود العميل في الرسالة إذا تُرك فارغاً
                  </span>
                )}
              </div>

              {/* Pharmacy Name */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  اسم الصيدلية (اختياري)
                </label>
                <input
                  type="text"
                  value={pharmacyName}
                  onChange={(e) => setPharmacyName(e.target.value)}
                  placeholder="اكتب اسم الصيدلية (اختياري)"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  لتنظيم اسم الجهة في التطبيق
                </span>
              </div>

              {/* Delivery Address */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  عنوان التوصيل (اختياري)
                </label>
                <textarea
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="مثال: شارع 15، عمارة 20، الدور الثالث، شقة 8 — مدينة نصر"
                  rows={2}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white resize-none"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  يظهر في رسالة الواتساب {customerCode.trim() ? 'تحت كود العميل' : 'في نهاية الرسالة'}
                </span>
              </div>

              {/* Contact Phone */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  رقم التواصل (اختياري)
                </label>
                <input
                  type="tel"
                  inputMode="tel"
                  value={contactPhone}
                  onChange={(e) => {
                    const digits = normalizeArabicDigits(e.target.value).replace(/\D/g, '');
                    setContactPhone(digits);
                  }}
                  placeholder="مثال: 01012345678"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  رقمك الشخصي ليتصلوا بك للتأكيد — يظهر في رسالة الواتساب
                </span>
              </div>
            </div>

            {/* Live Preview of WhatsApp Message */}
            <div className="bg-white text-slate-700 rounded-2xl p-3.5 text-xs space-y-2 font-mono border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between text-[11px] text-teal-800 font-bold">
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3.5 h-3.5" />
                  {activeOrderItems && activeOrderItems.length > 0
                    ? 'معاينة طلب الأدوية المحددة في صفحة الشراء:'
                    : 'معاينة رسالة الواتساب الموجهة للصيدلية:'}
                </span>
                <span className="text-slate-500">
                  {formattedPhone ? `+${formattedPhone}` : 'لم يحدد الرقم بعد'}
                </span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-[11px] text-slate-700 leading-relaxed whitespace-pre-line select-text max-h-44 overflow-y-auto">
                {previewMsg}
              </div>

              {/* Test / Send WhatsApp Link Button */}
              {pharmacyPhone.trim() && (
                <div className="flex items-center gap-2 pt-1">
                  <a
                    href={waUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-2.5 px-3 bg-[#25D366] hover:bg-[#20bd5a] text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition shadow-sm"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>فتح واتساب الآن ({formattedPhone || pharmacyPhone})</span>
                  </a>
                  <a
                    href={appUrl}
                    className="py-2.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-[11px] font-bold transition border border-slate-700 shrink-0"
                    title="فتح عبر تطبيق واتساب مباشرة"
                  >
                    تطبيق الهاتف
                  </a>
                </div>
              )}
            </div>
          </div>}

          {/* Submit Button */}
          <div className="pt-2">
            <button
              type="submit"
              className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 active:scale-98 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition"
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
