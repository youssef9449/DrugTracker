import type { FC } from 'react';
import { MessageCircle, ExternalLink, X } from 'lucide-react';
import type { Pharmacy, PharmacySettings } from '../types';
import { describeOrderInBoxes, isSolidUnit } from '../utils/medicationPackaging';
import { pluralizeArabic } from '../lib/arabicPlural';
import { describeOrderQuantityBreakdown, type OrderItem } from '../utils/whatsapp';
import { Checkbox } from './ui/Checkbox';

interface PharmacyShoppingSendModalProps {
  isOpen: boolean;
  settings: PharmacySettings;
  onUpdateSettings: (settings: PharmacySettings) => void;
  pharmacies: Pharmacy[];
  selectedPharmacy: Pharmacy | undefined;
  whatsappContacts: NonNullable<PharmacySettings['whatsappContacts']>;
  whatsappAddresses: NonNullable<PharmacySettings['whatsappAddresses']>;
  selectedWhatsappContactIds: string[];
  selectedWhatsappAddressIds: string[];
  toggleWhatsappContact: (id: string) => void;
  toggleWhatsappAddress: (id: string) => void;
  selectedCount: number;
  hasPharmacyPhone: boolean;
  displayPhone: string;
  targetWaUrl: string;
  currentWhatsAppMessage: string;
  activeOrderItems: OrderItem[];
  onOpenUserContactsSettings: () => void;
  showToast: (message: string) => void;
  onClose: () => void;
}

export const PharmacyShoppingSendModal: FC<PharmacyShoppingSendModalProps> = ({
  isOpen,
  settings,
  onUpdateSettings,
  pharmacies,
  selectedPharmacy,
  whatsappContacts,
  whatsappAddresses,
  selectedWhatsappContactIds,
  selectedWhatsappAddressIds,
  toggleWhatsappContact,
  toggleWhatsappAddress,
  selectedCount,
  hasPharmacyPhone,
  displayPhone,
  targetWaUrl,
  currentWhatsAppMessage,
  activeOrderItems,
  onOpenUserContactsSettings,
  showToast,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
<div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-5 shadow-2xl border border-slate-100 space-y-4 max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-[#25D366]/15 text-[#25D366] flex items-center justify-center">
                  <MessageCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">إرسال الطلب للصيدلية</h3>
                  <p className="text-[11px] text-slate-500">تم تجهيز {selectedCount} أدوية بالكميات المطلوبة</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onClose()}
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* Selected pharmacy summary */}
            <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-200/80 space-y-2">
              <label className="block text-xs font-bold text-slate-700">
                الصيدلية التي سيتم إرسال الطلب إليها
                <select
                  value={selectedPharmacy?.id || ''}
                  onChange={(event) => onUpdateSettings({ ...settings, selectedPharmacyId: event.target.value })}
                  className="mt-1.5 w-full bg-white border border-slate-300 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-800 outline-none focus:ring-2 focus:ring-teal-500"
                  aria-label="اختيار صيدلية لإرسال الطلب"
                >
                  {pharmacies.length === 0 && <option value="">لا توجد صيدليات محفوظة</option>}
                  {pharmacies.map((pharmacy) => (
                    <option key={pharmacy.id} value={pharmacy.id}>{pharmacy.name}</option>
                  ))}
                  {pharmacies.length === 0 && selectedPharmacy && (
                    <option value={selectedPharmacy.id}>{selectedPharmacy.name}</option>
            
                </select>
              </label>
              <div className="flex items-center justify-between bg-white px-3 py-2 rounded-xl border border-slate-200">
                <span className="text-xs text-slate-500">رقم واتساب:</span>
                <span className="font-mono text-xs font-bold text-teal-900" dir="ltr">
                  {hasPharmacyPhone ? `+${displayPhone}` : 'غير متاح'}
                </span>
              </div>
            </div>
            <div className="bg-teal-50/60 rounded-2xl p-3.5 border border-teal-200/80 space-y-3">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-bold text-teal-950">بيانات المستخدم في الرسالة</h4>
                      <p className="text-[10px] text-teal-800 mt-0.5">اختر الأرقام والعناوين التي تريد إرسالها للصيدلية.</p>
                    </div>
                    <button
                      type="button"
                      onClick={onOpenUserContactsSettings}
                      className="shrink-0 rounded-xl border border-teal-300 bg-white px-2.5 py-1.5 text-[10px] font-bold text-teal-800 hover:bg-teal-100"
                    >
                      إدارة البيانات
                    </button>
                  </div>
                </div>
                {whatsappContacts.length > 0 ? (
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-bold text-slate-700">أرقام التواصل</span>
                    {whatsappContacts.map((contact) => (
                      <label key={contact.id} className="flex items-center gap-2 bg-white rounded-xl border border-slate-200 px-2.5 py-2 cursor-pointer">
                        <Checkbox
                          checked={selectedWhatsappContactIds.includes(contact.id)}
                          onChange={() => toggleWhatsappContact(contact.id)}
                          aria-label={`إضافة ${contact.label} إلى الرسالة`}
                        />
                        <span className="text-xs font-bold text-slate-700">{contact.label}</span>
                        <span className="text-xs font-mono text-slate-500 mr-auto" dir="ltr">{contact.phone}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-teal-300 bg-white px-3 py-2 text-[11px] text-teal-800">
                    لا توجد أرقام محفوظة. اضغط «إدارة البيانات» لإضافة رقم.
                  </p>
                )}
                {whatsappAddresses.length > 0 ? (
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-bold text-slate-700">العناوين</span>
                    {whatsappAddresses.map((item) => (
                      <label key={item.id} className="flex items-start gap-2 bg-white rounded-xl border border-slate-200 px-2.5 py-2 cursor-pointer">
                        <Checkbox
                          checked={selectedWhatsappAddressIds.includes(item.id)}
                          onChange={() => toggleWhatsappAddress(item.id)}
                          aria-label={`إضافة ${item.label} إلى الرسالة`}
                          className="mt-0.5"
                        />
                        <span className="text-xs font-bold text-slate-700">{item.label}</span>
                        <span className="text-[11px] text-slate-500 mr-auto text-left">{item.address}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-teal-300 bg-white px-3 py-2 text-[11px] text-teal-800">
                    لا توجد عناوين محفوظة. اضغط «إدارة البيانات» لإضافة عنوان.
                  </p>
                )}
              </div>
            {/* Direct Send Action Buttons */}
            {hasPharmacyPhone && (
              <div className="space-y-2">
                <a
                  href={targetWaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    showToast('تم فتح واتساب!');
                  }}
                  className="w-full h-11 px-6 bg-[#25D366] hover:bg-[#20bd5a] active:bg-[#1da851] text-white rounded-full font-semibold text-sm flex items-center justify-center gap-2.5 shadow-xs active:scale-98 transition text-center cursor-pointer"
                >
                  <MessageCircle className="w-5 h-5 shrink-0" />
                  <span>فتح محادثة واتساب الآن</span>
                  <ExternalLink className="w-4 h-4 opacity-80 shrink-0" />
                </a>
              </div>
            )}
            {/* Live WhatsApp message preview, matching AppSettingsModal. */}
            <div className="bg-white text-slate-700 rounded-2xl p-3.5 text-xs space-y-2 font-mono border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between text-[11px] text-teal-800 font-bold">
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3.5 h-3.5" />
                  معاينة طلب الأدوية المحددة في صفحة الشراء:
                </span>
                <span className="text-slate-500">
                  {displayPhone ? `+${displayPhone}` : 'لم يحدد الرقم بعد'}
                </span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-[11px] text-slate-700 leading-relaxed whitespace-pre-line select-text max-h-44 overflow-y-auto">
                {currentWhatsAppMessage || 'يرجى تحديد أدوية لمعاينة نص الرسالة.'}
              </div>
            </div>
            {/* Analyzed Items Breakdown */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-700">
                <span>تفاصيل الأدوية والكميات المطلوبة:</span>
                <span className="text-teal-700">{activeOrderItems.length} أدوية</span>
              </div>
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-2.5 max-h-40 overflow-y-auto space-y-1.5 text-xs">
                {activeOrderItems.map((item, idx) => {
                  const pkg = describeOrderInBoxes(item.quantity, item.stripsPerBox, item.pillsPerStrip, item.packageSize, item.unit);
                  const displayQty = pkg || (isSolidUnit(item.unit)
                    ? pluralizeArabic(Math.max(1, Math.ceil(item.quantity / (item.packageSize || 30))), 'علبة')
                    : `${item.quantity} ${item.unit}`);
                  return (
                    <div key={idx} className="flex items-center justify-between py-1 border-b border-slate-200/60 last:border-b-0">
                      <span className="font-bold text-slate-800">{item.name}</span>
                      <span className="text-[11px] text-teal-800 bg-teal-50 px-2 py-0.5 rounded-lg border border-teal-200/60 font-semibold">
                        {displayQty}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
  );
};
