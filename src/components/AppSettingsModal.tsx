import { useState, useEffect, type FC, type FormEvent, type ChangeEvent } from 'react';
import {
  X,
  Settings,
  Phone,
  UserCheck,
  Check,
  MessageSquare,
  MessageCircle,
  Volume2,
  VolumeX,
  FileAudio,
  Trash2,
  Bell,
  BellOff,
  AlertTriangle,
  Zap,
  ZapOff,
} from 'lucide-react';
import { Medication, PharmacySettings } from '../types';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  openWhatsAppLink,
  calculateMedicationOrderQuantity,
  OrderItem,
  buildWhatsAppUrl,
  buildWhatsAppAppUrl,
} from '../utils/whatsapp';
import { readCustomSoundFile, CUSTOM_SOUND_ACCEPT_ATTR } from '../utils/sound';
import { normalizeArabicDigits } from '../utils/whatsapp';

export interface AppSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode?: 'all' | 'pharmacy';
  settings: PharmacySettings;
  medications: Medication[];
  activeOrderItems?: OrderItem[];
  onSaveSettings: (newSettings: PharmacySettings) => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  globalCustomSound?: { fileName: string; mimeType: string; dataUrl: string } | null;
  onSetGlobalCustomSound: (file: { fileName: string; mimeType: string; dataUrl: string } | null) => void;
  notificationsEnabled?: boolean;
  onToggleNotifications?: () => void;
  criticalStockAlertsEnabled?: boolean;
  onToggleCriticalStockAlerts?: () => void;
  onSendTestNotification?: () => void;
  autoDeductEnabled?: boolean;
  onToggleAutoDeduct?: () => void;
}

export const AppSettingsModal: FC<AppSettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  medications,
  activeOrderItems,
  onSaveSettings,
  soundEnabled,
  onToggleSound,
  globalCustomSound,
  onSetGlobalCustomSound,
  notificationsEnabled = true,
  onToggleNotifications,
  criticalStockAlertsEnabled = true,
  onToggleCriticalStockAlerts,
  onSendTestNotification,
  autoDeductEnabled = true,
  onToggleAutoDeduct,
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

  // Synchronize state whenever modal opens or settings change externally.
  useEffect(() => {
    if (isOpen) {
      setPharmacyPhone(settings.pharmacyPhone || '');
      setPharmacyName((settings.pharmacyName === 'الصيدلية' ? '' : settings.pharmacyName) || '');
      setCustomerCode((settings.customerCode === '14739' ? '' : settings.customerCode) || '');
      setAddress(settings.address || '');
      setContactPhone(settings.contactPhone || '');
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  // Sound file picker — uses readCustomSoundFile for size/type validation.
  const handleSoundFilePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const customFile = await readCustomSoundFile(file);
      onSetGlobalCustomSound(customFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'تعذّر تحميل الملف الصوتي';
      window.alert(message);
    }
  };

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    onSaveSettings({
      pharmacyPhone: pharmacyPhone.trim(),
      pharmacyName: pharmacyName.trim(),
      customerCode: customerCode.trim(),
      // Preserve the duration/quantities managed by the shopping view.
      defaultDurationDays: settings.defaultDurationDays,
      customQuantities: settings.customQuantities,
      address: address.trim(),
      contactPhone: contactPhone.trim(),
    });
    onClose();
  };

  const formattedPhone = cleanPhoneNumber(pharmacyPhone);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs">
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
                  : 'تخصيص الخصم التلقائي، الإشعارات، وبيانات الصيدلية'}
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
                        autoDeductEnabled ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {autoDeductEnabled ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-800">الخصم التلقائي اليومي للمخزون</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                            autoDeductEnabled ? 'bg-teal-200 text-teal-900' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {autoDeductEnabled ? 'مفعّل' : 'متوقف'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        خصم الجرعات تلقائياً بمرور الأيام لتحديث رصيدك وموعد النفاذ
                      </p>
                    </div>
                  </div>
                  {onToggleAutoDeduct && (
                    <button
                      type="button"
                      onClick={onToggleAutoDeduct}
                      className={`w-10 h-5 rounded-full relative transition ${
                        autoDeductEnabled ? 'bg-teal-600' : 'bg-slate-300'
                      }`}
                      aria-label="تبديل الخصم التلقائي اليومي"
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition ${
                          autoDeductEnabled ? 'right-0.5' : 'right-[18px]'
                        }`}
                      />
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-slate-500 leading-relaxed border-t border-teal-100/80 pt-2">
                  {autoDeductEnabled
                    ? 'عند التفعيل، يحسب التطبيق الجرعات اليومية تلقائياً ويحدّث رصيد المخزون وموعد نفاد كل دواء.'
                    : 'عند الإيقاف، يتوقف الخصم التلقائي ويبقى رصيد الأدوية ثابتاً حتى تقوم بالخصم اليدوي.'}
                </p>
              </div>

              {/* Notifications & Alerts Management Section */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        notificationsEnabled ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {notificationsEnabled ? (
                        <Bell className="w-4 h-4 fill-amber-500" />
                      ) : (
                        <BellOff className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <span className="text-xs font-bold text-slate-800">التنبيهات وإشعارات الهاتف</span>
                      <p className="text-[10px] text-slate-500">منبه مواعيد الجرعات وتنبيهات المخزون</p>
                    </div>
                  </div>
                  {onToggleNotifications && (
                    <button
                      type="button"
                      onClick={onToggleNotifications}
                      className={`w-10 h-5 rounded-full relative transition ${
                        notificationsEnabled ? 'bg-teal-600' : 'bg-slate-300'
                      }`}
                      aria-label="تبديل التنبيهات"
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition ${
                          notificationsEnabled ? 'right-0.5' : 'right-[18px]'
                        }`}
                      />
                    </button>
                  )}
                </div>

                <hr className="border-slate-200" />

                {/* Critical Stock Alerts Toggle */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        criticalStockAlertsEnabled ? 'bg-rose-100 text-rose-600' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      <AlertTriangle
                        className={`w-4 h-4 ${
                          criticalStockAlertsEnabled ? 'fill-rose-500/30' : ''
                        }`}
                      />
                    </div>
                    <div>
                      <span className="text-xs font-bold text-slate-800">تنبيهات النفاذ الحرج للمخزون</span>
                      <p className="text-[10px] text-slate-500">
                        إشعار فوري عند اقتراب نفاد الدواء أو نفاذه (حسب إعداد كل دواء)
                      </p>
                    </div>
                  </div>
                  {onToggleCriticalStockAlerts && (
                    <button
                      type="button"
                      onClick={onToggleCriticalStockAlerts}
                      className={`w-10 h-5 rounded-full relative transition ${
                        criticalStockAlertsEnabled ? 'bg-rose-600' : 'bg-slate-300'
                      }`}
                      aria-label="تبديل تنبيهات النفاذ الحرج"
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition ${
                          criticalStockAlertsEnabled ? 'right-0.5' : 'right-[18px]'
                        }`}
                      />
                    </button>
                  )}
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
              </div>

              {/* Sound management section */}
              <div className="bg-teal-50/70 border border-teal-200/80 rounded-2xl p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    {soundEnabled ? (
                      <Volume2 className="w-4 h-4 text-teal-600" />
                    ) : (
                      <VolumeX className="w-4 h-4 text-slate-400" />
                    )}
                    <span className="text-xs font-bold text-slate-700">تأثيرات صوتية في التطبيق</span>
                  </div>
                  <button
                    type="button"
                    onClick={onToggleSound}
                    className={`w-10 h-5 rounded-full relative transition ${
                      soundEnabled ? 'bg-teal-600' : 'bg-slate-300'
                    }`}
                    aria-label="تبديل التأثيرات الصوتية"
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition ${
                        soundEnabled ? 'right-0.5' : 'right-[18px]'
                      }`}
                    />
                  </button>
                </div>

                <hr className="border-teal-100" />

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700">صوت تنبيه مخصص من جهازك</span>
                    <span className="text-[10px] text-teal-700 font-medium">اختياري</span>
                  </div>
                  {globalCustomSound ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 bg-teal-50 border border-teal-200 rounded-xl px-2.5 py-1.5">
                        <FileAudio className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                        <span
                          className="text-[11px] text-teal-800 font-bold truncate flex-1"
                          title={globalCustomSound.fileName}
                        >
                          {globalCustomSound.fileName}
                        </span>
                        <button
                          type="button"
                          onClick={() => onSetGlobalCustomSound(null)}
                          className="text-rose-500 hover:text-rose-700 transition shrink-0"
                          title="إزالة"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <label className="block w-full py-1.5 px-2 rounded-xl text-[11px] font-bold text-center cursor-pointer bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100 transition">
                        <input
                          type="file"
                          accept={CUSTOM_SOUND_ACCEPT_ATTR}
                          className="sr-only"
                          onChange={handleSoundFilePick}
                        />
                        تغيير الملف
                      </label>
                    </div>
                  ) : (
                    <label className="block w-full py-2 px-2 rounded-xl text-[11px] font-bold text-center cursor-pointer bg-teal-50 text-teal-800 border border-teal-200 hover:bg-teal-100 transition">
                      <input
                        type="file"
                        accept={CUSTOM_SOUND_ACCEPT_ATTR}
                        className="sr-only"
                        onChange={handleSoundFilePick}
                      />
                      📂 اختر ملفاً صوتياً من جهازك
                    </label>
                  )}
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    الصوت المخصص يُطبّق على كل إشعارات الأدوية (تذكير الجرعات + تنبيهات النفاذ). MP3 / WAV / OGG، حد أقصى 2MB.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* Pharmacy and WhatsApp Configuration Section */}
          <div className="space-y-3 pt-1">
            {!isPharmacyOnly && (
              <div className="border-t border-slate-200 pt-3">
                <h4 className="text-xs font-bold text-slate-800 mb-1 flex items-center gap-1.5">
                  <Phone className="w-4 h-4 text-teal-600" />
                  <span>بيانات الصيدلية وطلب الواتساب</span>
                </h4>
                <p className="text-[11px] text-slate-500 mb-3">
                  تحديد بيانات الصيدلية والتوصيل لتجهيز وإرسال الطلبات بنقرة واحدة
                </p>
              </div>
            )}

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
            {(() => {
              const orderItemsForMessage: OrderItem[] = (activeOrderItems && activeOrderItems.length > 0)
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

              const previewMsg = generatePharmacyOrderMessage(
                orderItemsForMessage,
                customerCode,
                address,
                contactPhone
              );

              const waUrl = buildWhatsAppUrl(pharmacyPhone, previewMsg);
              const appUrl = buildWhatsAppAppUrl(pharmacyPhone, previewMsg);

              return (
                <div className="bg-slate-900 text-slate-100 rounded-2xl p-3.5 text-xs space-y-2 font-mono shadow-inner">
                  <div className="flex items-center justify-between text-[11px] text-teal-400 font-bold">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5" />
                      {activeOrderItems && activeOrderItems.length > 0
                        ? 'معاينة طلب الأدوية المحددة في صفحة الشراء:'
                        : 'معاينة رسالة الواتساب الموجهة للصيدلية:'}
                    </span>
                    <span className="text-slate-300">
                      {formattedPhone ? `+${formattedPhone}` : 'لم يحدد الرقم بعد'}
                    </span>
                  </div>
                  <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700 text-[11px] text-slate-200 leading-relaxed whitespace-pre-line select-text max-h-44 overflow-y-auto">
                    {previewMsg}
                  </div>

                  {/* Test / Send WhatsApp Link Button */}
                  {pharmacyPhone.trim() && (
                    <div className="flex items-center gap-2 pt-1">
                      <a
                        href={waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => {
                          openWhatsAppLink(pharmacyPhone, previewMsg);
                        }}
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
              );
            })()}
          </div>

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
    </div>
  );
};

// Backwards compatibility alias
export { AppSettingsModal as PharmacySettingsModal };
export type { AppSettingsModalProps as PharmacySettingsModalProps };
