import { useState, useEffect, type FC, type FormEvent } from 'react';
import {
  X,
  Settings,
  Phone,
  UserCheck,
  Check,
  Pill,
  MessageSquare,
  MessageCircle,
  RotateCcw,
} from 'lucide-react';
import { Medication, PharmacySettings, describeOrderInBoxes } from '../types';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  openWhatsAppLink,
  calculateMedicationOrderQuantity,
} from '../utils/whatsapp';

interface PharmacySettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: PharmacySettings;
  medications: Medication[];
  onSaveSettings: (newSettings: PharmacySettings) => void;
}

export const PharmacySettingsModal: FC<PharmacySettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  medications,
  onSaveSettings,
}) => {
  const [pharmacyPhone, setPharmacyPhone] = useState(settings.pharmacyPhone || '');
  const [pharmacyName, setPharmacyName] = useState(settings.pharmacyName || 'الصيدلية');
  const [customerCode, setCustomerCode] = useState(settings.customerCode || '');
  const [defaultDurationDays, setDefaultDurationDays] = useState<30 | 60>(
    settings.defaultDurationDays || 30
  );
  const [customQuantities, setCustomQuantities] = useState<Record<string, number>>(
    settings.customQuantities || {}
  );
  const [address, setAddress] = useState(settings.address || '');
  const [contactPhone, setContactPhone] = useState(settings.contactPhone || '');

  // Synchronize state whenever modal opens or settings change externally
  useEffect(() => {
    if (isOpen) {
      setPharmacyPhone(settings.pharmacyPhone || '');
      setPharmacyName(settings.pharmacyName || 'الصيدلية');
      setCustomerCode(settings.customerCode || '');
      setDefaultDurationDays(settings.defaultDurationDays || 30);
      setCustomQuantities(settings.customQuantities || {});
      setAddress(settings.address || '');
      setContactPhone(settings.contactPhone || '');
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleQuantityChange = (medId: string, newDisplayVal: number) => {
    const monthsMultiplier = defaultDurationDays === 60 ? 2 : 1;
    const baseMonthly = Math.max(1, Math.round(newDisplayVal / monthsMultiplier));
    setCustomQuantities((prev) => ({
      ...prev,
      [medId]: baseMonthly,
    }));
  };

  const handleResetMedQuantity = (medId: string) => {
    setCustomQuantities((prev) => {
      const copy = { ...prev };
      delete copy[medId];
      return copy;
    });
  };

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    onSaveSettings({
      pharmacyPhone: pharmacyPhone.trim(),
      pharmacyName: pharmacyName.trim() || 'الصيدلية',
      customerCode: customerCode.trim(),
      defaultDurationDays,
      customQuantities,
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
              <Settings className="w-4 h-4 text-teal-100" />
            </div>
            <div>
              <h3 className="font-bold text-base">إعدادات الصيدلية والواتساب</h3>
              <p className="text-[11px] text-teal-200">
                تحديد رقم الصيدلية والكميات المطلوبة ورقم العميل
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-teal-200 hover:text-white hover:bg-teal-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="p-5 overflow-y-auto space-y-4 flex-1">
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
                <span>رقم العميل في الصيدلية</span>
              </label>
              <input
                type="text"
                value={customerCode}
                onChange={(e) => setCustomerCode(e.target.value)}
                placeholder="14739"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
              <span className="text-[10px] text-slate-500 mt-1 block">
                يظهر في نهاية الرسالة: (رقم العميل {customerCode || '—'})
              </span>
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
                placeholder="مثال: صيدلية الحي"
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
                يظهر في رسالة الواتساب تحت رقم العميل
              </span>
            </div>

            {/* Contact Phone */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                رقم التواصل (اختياري)
              </label>
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="مثال: 01012345678"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
              <span className="text-[10px] text-slate-500 mt-1 block">
                رقمك الشخصي ليتصلوا بك للتأكيد — يظهر في رسالة الواتساب
              </span>
            </div>
          </div>

          {/* Preferred Duration Default */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              مدة التغطية الافتراضية لحساب النواقص
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDefaultDurationDays(30)}
                className={`py-2 px-3 rounded-xl text-xs font-bold border transition ${
                  defaultDurationDays === 30
                    ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                تغطية شهر (30 يوماً)
              </button>
              <button
                type="button"
                onClick={() => setDefaultDurationDays(60)}
                className={`py-2 px-3 rounded-xl text-xs font-bold border transition ${
                  defaultDurationDays === 60
                    ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                تغطية شهرين (60 يوماً)
              </button>
            </div>
          </div>

          {/* Section: Custom Requested Quantities Per Medicine */}
          <div className="space-y-2 pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <Pill className="w-4 h-4 text-teal-600" />
                  <span>تحديد الكمية المطلوبة للشراء من كل دواء</span>
                </h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  الكمية المحسوبة حالياً ({defaultDurationDays === 60 ? 'تغطية شهرين مضاعفة' : 'تغطية شهر واحد'}):
                </p>
              </div>
            </div>

            <div className="space-y-2 max-h-56 overflow-y-auto pr-0.5">
              {medications.map((med) => {
                const { quantity: currentQty, isCustom } =
                  calculateMedicationOrderQuantity(
                    med,
                    defaultDurationDays,
                    customQuantities
                  );

                return (
                  <div
                    key={med.id}
                    className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-slate-800 block text-xs">
                          {med.name}
                        </span>
                        {isCustom && (
                          <button
                            type="button"
                            onClick={() => handleResetMedQuantity(med.id)}
                            className="text-[10px] text-teal-700 hover:text-teal-900 bg-teal-100 px-1.5 py-0.5 rounded font-bold flex items-center gap-0.5"
                            title="إعادة ضبط للحساب التلقائي"
                          >
                            <RotateCcw className="w-2.5 h-2.5" />
                            <span>مخصصة (إلغاء التخصيص)</span>
                          </button>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-500 block">
                        المخزون الحالي: {med.currentPills} {med.unit} (الاستهلاك:{' '}
                        {med.dailyDose}/يوم)
                      </span>
                      <span className="text-[11px] font-bold text-teal-800 bg-teal-50 px-1.5 py-0.5 rounded border border-teal-200/60 inline-block mt-1">
                        الطلب: {describeOrderInBoxes(currentQty, med.stripsPerBox, med.pillsPerStrip, med.packageSize, med.unit)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {(() => {
                        const boxStep =
                          med.stripsPerBox && med.pillsPerStrip && med.stripsPerBox > 0 && med.pillsPerStrip > 0
                            ? med.stripsPerBox * med.pillsPerStrip
                            : med.packageSize && med.packageSize > 0
                            ? med.packageSize
                            : 30;

                        return (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                handleQuantityChange(
                                  med.id,
                                  Math.max(1, currentQty - boxStep)
                                )
                              }
                              className="w-7 h-7 rounded-lg bg-white border border-slate-300 font-bold text-slate-700 hover:bg-slate-100 flex items-center justify-center active:scale-95"
                              title="تقليل بمقدار علبة"
                            >
                              -
                            </button>

                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min="1"
                                value={currentQty}
                                onChange={(e) =>
                                  handleQuantityChange(med.id, parseInt(e.target.value) || 0)
                                }
                                className="w-16 px-1.5 py-1 text-center font-mono font-bold text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500"
                              />
                              <span className="text-[11px] text-slate-600 font-medium">
                                {med.unit}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={() =>
                                handleQuantityChange(
                                  med.id,
                                  currentQty + boxStep
                                )
                              }
                              className="w-7 h-7 rounded-lg bg-white border border-slate-300 font-bold text-slate-700 hover:bg-slate-100 flex items-center justify-center active:scale-95"
                              title="زيادة بمقدار علبة"
                            >
                              +
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Live Preview of WhatsApp Message */}
          <div className="bg-slate-900 text-slate-100 rounded-2xl p-3.5 text-xs space-y-2 font-mono shadow-inner">
            <div className="flex items-center justify-between text-[11px] text-teal-400 font-bold">
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3.5 h-3.5" />
                معاينة رسالة الواتساب النهائية الموجهة للصيدلية:
              </span>
              <span className="text-slate-300">
                {formattedPhone ? `+${formattedPhone}` : 'لم يحدد الرقم بعد'}
              </span>
            </div>
            <div className="bg-slate-800/80 p-2.5 rounded-xl border border-slate-700 text-[11px] text-slate-200 leading-relaxed whitespace-pre-line select-text max-h-44 overflow-y-auto">
              {generatePharmacyOrderMessage(
                medications.map((m) => {
                  const { quantity } = calculateMedicationOrderQuantity(
                    m,
                    defaultDurationDays,
                    customQuantities
                  );
                  return {
                    name: m.name,
                    quantity,
                    unit: m.unit,
                    stripsPerBox: m.stripsPerBox,
                    pillsPerStrip: m.pillsPerStrip,
                    packageSize: m.packageSize,
                  };
                }),
                customerCode,
                address,
                contactPhone
              )}
            </div>

            {/* Test WhatsApp Link Button */}
            {pharmacyPhone.trim() && (
              <button
                type="button"
                onClick={() => {
                  const msg = generatePharmacyOrderMessage(
                    medications.map((m) => {
                      const { quantity } = calculateMedicationOrderQuantity(
                        m,
                        defaultDurationDays,
                        customQuantities
                      );
                      return {
                        name: m.name,
                        quantity,
                        unit: m.unit,
                        stripsPerBox: m.stripsPerBox,
                        pillsPerStrip: m.pillsPerStrip,
                        packageSize: m.packageSize,
                      };
                    }),
                    customerCode,
                    address,
                    contactPhone
                  );
                  openWhatsAppLink(pharmacyPhone, msg);
                }}
                className="w-full py-2 px-3 bg-[#25D366]/20 hover:bg-[#25D366]/30 text-emerald-300 border border-[#25D366]/40 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition"
              >
                <MessageCircle className="w-4 h-4 text-[#25D366]" />
                <span>تجربة فتح واتساب الآن للرقم ({formattedPhone || pharmacyPhone})</span>
              </button>
            )}
          </div>

          {/* Submit Button */}
          <div className="pt-2">
            <button
              type="submit"
              className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 active:scale-98 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition"
            >
              <Check className="w-4 h-4" />
              <span>حفظ إعدادات الصيدلية والكميات</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
