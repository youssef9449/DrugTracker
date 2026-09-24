import type { FC } from 'react';
import { MessageSquare, MessageCircle } from 'lucide-react';

export interface WhatsAppPreviewSectionProps {
  previewMsg: string;
  waUrl: string;
  appUrl: string;
  pharmacyPhone: string;
  formattedPhone: string;
  hasActiveOrderItems: boolean;
}

/** WhatsApp order message preview + open links. */
export const WhatsAppPreviewSection: FC<WhatsAppPreviewSectionProps> = ({
  previewMsg,
  waUrl,
  appUrl,
  pharmacyPhone,
  formattedPhone,
  hasActiveOrderItems,
}) => (
  <div className="bg-white border border-slate-200/80 rounded-2xl p-3.5 space-y-2.5">
    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
      <span className="flex items-center gap-1">
        <MessageSquare className="w-3.5 h-3.5" />
        {hasActiveOrderItems
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
    {pharmacyPhone.trim() && (
      <div className="flex items-center gap-2 pt-1">
        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 h-10 px-4 bg-[#25D366] hover:bg-[#20bd5a] text-white rounded-full text-xs font-semibold flex items-center justify-center gap-2 transition active:scale-98 shadow-2xs cursor-pointer"
        >
          <MessageCircle className="w-4 h-4" />
          <span>فتح واتساب الآن ({formattedPhone || pharmacyPhone})</span>
        </a>
        <a
          href={appUrl}
          className="h-10 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full text-xs font-semibold transition border border-slate-700 shrink-0 flex items-center justify-center cursor-pointer"
          title="فتح عبر تطبيق واتساب مباشرة"
        >
          تطبيق الهاتف
        </a>
      </div>
    )}
  </div>
);
