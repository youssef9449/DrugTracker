import type { FC } from 'react';
import { Phone, UserCheck } from 'lucide-react';
import { WhatsAppPreviewSection } from './WhatsAppPreviewSection';

export interface PharmacySettingsSectionProps {
  pharmacyPhone: string;
  formattedPhone: string;
  customerCode: string;
  pharmacyName: string;
  address: string;
  contactPhone: string;
  previewMsg: string;
  waUrl: string;
  appUrl: string;
  hasActiveOrderItems: boolean;
}

/** Pharmacy contact fields + WhatsApp preview workflow. */
export const PharmacySettingsSection: FC<PharmacySettingsSectionProps> = ({
  pharmacyPhone,
  formattedPhone,
  customerCode,
  pharmacyName,
  address,
  contactPhone,
  previewMsg,
  waUrl,
  appUrl,
  hasActiveOrderItems,
}) => (
  <div className="space-y-3 pt-1">
    <div className="bg-teal-50/70 border border-teal-200/80 rounded-2xl p-3.5 space-y-2">
      <label className="block text-xs font-bold text-teal-950 flex items-center gap-1.5">
        <Phone className="w-4 h-4 text-teal-700" />
        <span>
          رقم هاتف الصيدلية (واتساب) <span className="text-red-500">*</span>
        </span>
      </label>
      <input
        type="tel"
        value={pharmacyPhone}
        readOnly
        placeholder="اختر صيدلية من إدارة الصيدليات"
        className="w-full px-3.5 py-2.5 rounded-xl border border-teal-300 text-sm font-mono bg-slate-50 text-slate-700"
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

    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
          <UserCheck className="w-3.5 h-3.5 text-slate-500" />
          <span>كود العميل (اختياري)</span>
        </label>
        <input
          type="text"
          value={customerCode}
          readOnly
          placeholder="مثال: C-1024"
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
        />
        {customerCode.trim() ? (
          <span className="text-[10px] text-teal-700 font-medium mt-1 block">
            يظهر في نهاية الرسالة: (كود العميل {customerCode.trim()})
          </span>
        ) : (
          <span className="text-[10px] text-slate-500 mt-1 block">
            إن وُجد يظهر في رسالة الواتساب
          </span>
        )}
      </div>
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">
          اسم الصيدلية (اختياري)
        </label>
        <input
          type="text"
          value={pharmacyName}
          readOnly
          placeholder="مثال: صيدلية النهدي"
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
        />
      </div>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">
          عنوان التوصيل (اختياري)
        </label>
        <textarea
          value={address}
          readOnly
          placeholder="مثال: شارع 15، عمارة 20، الدور الثالث، شقة 8 — مدينة نصر"
          rows={2}
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white resize-none"
        />
        <span className="text-[10px] text-slate-500 mt-1 block">
          يظهر في رسالة الواتساب{' '}
          {customerCode.trim() ? 'تحت كود العميل' : 'في نهاية الرسالة'}
        </span>
      </div>
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">
          رقم التواصل (اختياري)
        </label>
        <input
          type="tel"
          inputMode="tel"
          value={contactPhone}
          readOnly
          placeholder="مثال: 01012345678"
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
        />
        <span className="text-[10px] text-slate-500 mt-1 block">
          رقمك الشخصي ليتصلوا بك للتأكيد — يظهر في رسالة الواتساب
        </span>
      </div>
    </div>

    <WhatsAppPreviewSection
      previewMsg={previewMsg}
      waUrl={waUrl}
      appUrl={appUrl}
      pharmacyPhone={pharmacyPhone}
      formattedPhone={formattedPhone}
      hasActiveOrderItems={hasActiveOrderItems}
    />
  </div>
);
