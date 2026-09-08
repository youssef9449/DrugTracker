import React, { useState, useMemo, useEffect } from 'react';
import {
  Copy,
  Check,
  Settings,
  Phone,
  MessageCircle,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronUp,
  RotateCcw,
} from 'lucide-react';
import { Medication, PharmacySettings, calculateMedicationStatus, describeOrderInBoxes } from '../types';
import { getDepletionDate } from '../utils/dateCalculations';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  openWhatsAppLink,
  OrderItem,
  calculateMedicationOrderQuantity,
} from '../utils/whatsapp';

interface PharmacyShoppingViewProps {
  medications: Medication[];
  settings: PharmacySettings;
  onUpdateSettings: (newSettings: PharmacySettings) => void;
  onOpenSettings: () => void;
  onConfirmRefill: (medicationId: string, addedPills: number) => void;
  showToast: (message: string) => void;
}

export const PharmacyShoppingView: React.FC<PharmacyShoppingViewProps> = ({
  medications,
  settings,
  onUpdateSettings,
  onOpenSettings,
  showToast,
}) => {
  const [durationDays, setDurationDays] = useState<30 | 60>(settings.defaultDurationDays || 30);

  useEffect(() => {
    if (settings.defaultDurationDays) setDurationDays(settings.defaultDurationDays);
  }, [settings.defaultDurationDays]);

  const [copied, setCopied] = useState(false);
  const [showAllForPlanning, setShowAllForPlanning] = useState(false);
  const [showPreviewMessage, setShowPreviewMessage] = useState(false);

  const urgentMeds = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    });
  }, [medications]);

  const effectiveShowAll = showAllForPlanning || urgentMeds.length === 0;
  const displayList = effectiveShowAll ? medications : urgentMeds;

  const [selectedMedIds, setSelectedMedIds] = useState<Set<string>>(() => {
    const initialList = urgentMeds.length > 0 ? urgentMeds : medications;
    return new Set(initialList.map((m) => m.id));
  });

  const handleToggleSelect = (id: string) => {
    setSelectedMedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDurationChange = (newDuration: 30 | 60) => {
    setDurationDays(newDuration);
    onUpdateSettings({ ...settings, defaultDurationDays: newDuration });
    showToast(newDuration === 60 ? 'تم التبديل لتغطية شهرين' : 'تم التبديل لتغطية شهر');
  };

  const getRequestedAmount = (med: Medication) =>
    calculateMedicationOrderQuantity(med, durationDays, settings.customQuantities);

  const handleDirectQuantityChange = (medId: string, newDisplayQty: number) => {
    const monthsMultiplier = durationDays === 60 ? 2 : 1;
    const baseMonthly = Math.max(1, Math.round(newDisplayQty / monthsMultiplier));
    onUpdateSettings({
      ...settings,
      customQuantities: { ...settings.customQuantities, [medId]: baseMonthly },
    });
  };

  const handleResetToAuto = (medId: string) => {
    const nextCustom = { ...settings.customQuantities };
    delete nextCustom[medId];
    onUpdateSettings({ ...settings, customQuantities: nextCustom });
  };

  const generateWhatsAppMessage = (): string => {
    const itemsToOrder: OrderItem[] = displayList
      .filter((med) => selectedMedIds.has(med.id))
      .map((med) => {
        const { quantity } = getRequestedAmount(med);
        return {
          name: med.name,
          quantity,
          unit: med.unit,
          stripsPerBox: med.stripsPerBox,
          pillsPerStrip: med.pillsPerStrip,
          packageSize: med.packageSize,
        };
      });
    if (itemsToOrder.length === 0) return '';
    return generatePharmacyOrderMessage(itemsToOrder, settings.customerCode || '14739');
  };

  const handleSendToWhatsApp = () => {
    if (!settings.pharmacyPhone?.trim()) {
      showToast('يرجى إدخال رقم هاتف الصيدلية أولاً في الإعدادات.');
      onOpenSettings();
      return;
    }
    const message = generateWhatsAppMessage();
    if (!message) {
      showToast('يرجى تحديد دواء واحد على الأقل لإرسال الطلب.');
      return;
    }
    openWhatsAppLink(settings.pharmacyPhone, message);
    showToast('جاري فتح محادثة الصيدلية على واتساب...');
  };

  const handleCopyOrder = async () => {
    const orderText = generateWhatsAppMessage();
    if (!orderText) {
      showToast('يرجى تحديد دواء واحد على الأقل لنسخ الطلب.');
      return;
    }
    try {
      await navigator.clipboard.writeText(orderText);
      setCopied(true);
      showToast('تم نسخ رسالة الواتساب بنجاح!');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      showToast('تعذر النسخ التلقائي.');
    }
  };

  const hasPharmacyPhone = Boolean(settings.pharmacyPhone?.trim());
  const displayPhone = settings.pharmacyPhone ? cleanPhoneNumber(settings.pharmacyPhone) : '';
  const selectedCount = displayList.filter((m) => selectedMedIds.has(m.id)).length;
  const currentWhatsAppMessage = generateWhatsAppMessage();

  return (
    <div className="p-4 space-y-4">
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-xs flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <Phone className="w-4 h-4" />
          </div>
          <div className="min-w-0 text-xs">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-slate-800 truncate">{settings.pharmacyName || 'الصيدلية'}</span>
              {hasPharmacyPhone ? (
                <span className="font-mono text-[11px] bg-teal-50 text-teal-800 px-2 py-0.5 rounded-md border border-teal-200 font-bold">
                  +{displayPhone}
                </span>
              ) : (
                <span className="text-[10px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200 font-medium">
                  اكتب رقم الصيدلية لإرسال الطلب
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              رقم العميل: <strong className="text-teal-800 font-mono">{settings.customerCode || '14739'}</strong>
            </div>
          </div>
        </div>
        <button
          onClick={onOpenSettings}
          className="shrink-0 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>{hasPharmacyPhone ? 'تعديل' : 'إضافة الرقم'}</span>
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs space-y-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">قائمة الشراء وتجهيز طلب الصيدلية</h2>
          <p className="text-xs text-slate-500 mt-0.5">تُدرج أسماء الأدوية والكميات تلقائياً وتُرسل مباشرة لواتساب الصيدلية</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            onClick={handleSendToWhatsApp}
            disabled={selectedCount === 0}
            className={`w-full py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 ${
              selectedCount === 0 ? 'bg-slate-200 text-slate-400' : 'bg-emerald-500 hover:bg-emerald-600 text-white'
            }`}
          >
            <MessageCircle className="w-4 h-4" />
            إرسال لواتساب ({selectedCount})
          </button>
          <button
            onClick={handleCopyOrder}
            disabled={selectedCount === 0}
            className={`w-full py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 border ${
              copied ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : 'bg-white text-slate-700 border-slate-200'
            }`}
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'تم النسخ!' : 'نسخ نص الرسالة'}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowPreviewMessage(!showPreviewMessage)}
          className="w-full flex items-center justify-between text-xs text-slate-600 py-1 font-medium"
        >
          <span>معاينة نص الرسالة</span>
          {showPreviewMessage ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        {showPreviewMessage && (
          <div className="p-3 bg-slate-900 text-slate-100 rounded-xl text-xs font-mono whitespace-pre-line">
            {currentWhatsAppMessage || 'يرجى تحديد أدوية لمعاينة نص الرسالة.'}
          </div>
        )}
        <div className="pt-2 border-t border-slate-100 flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl">
            <button
              type="button"
              onClick={() => handleDurationChange(30)}
              className={`px-3 py-1.5 rounded-lg font-bold ${durationDays === 30 ? 'bg-teal-700 text-white' : 'text-slate-600 bg-white/70'}`}
            >
              شهر (30 يوم)
            </button>
            <button
              type="button"
              onClick={() => handleDurationChange(60)}
              className={`px-3 py-1.5 rounded-lg font-bold ${durationDays === 60 ? 'bg-teal-700 text-white' : 'text-slate-600 bg-white/70'}`}
            >
              شهرين (60 يوم)
            </button>
          </div>
          <button onClick={() => setShowAllForPlanning(!showAllForPlanning)} className="text-teal-700 font-bold underline text-[11px]">
            {showAllForPlanning ? 'عرض النواقص فقط' : 'عرض كل الأدوية'}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs px-1">
        <span className="font-bold text-slate-700">
          الأدوية المتاحة للطلب ({selectedCount} من {displayList.length})
        </span>
        <div className="flex items-center gap-2 text-[11px]">
          <button onClick={() => setSelectedMedIds(new Set(displayList.map((m) => m.id)))} className="text-teal-700 font-bold">
            تحديد الكل
          </button>
          <button onClick={() => setSelectedMedIds(new Set())} className="text-slate-500">
            إلغاء
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {displayList.map((med) => {
          const { status } = calculateMedicationStatus(med);
          const { quantity: suggestedPills, isCustom } = getRequestedAmount(med);
          const depletion = getDepletionDate(med);
          const isSelected = selectedMedIds.has(med.id);
          const boxStep = med.stripsPerBox && med.pillsPerStrip ? med.stripsPerBox * med.pillsPerStrip : med.packageSize || 30;
          return (
            <div
              key={med.id}
              className={`bg-white rounded-2xl border p-3.5 shadow-xs ${
                isSelected ? 'border-teal-300 ring-1 ring-teal-100' : 'border-slate-200/80 opacity-75'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2.5 min-w-0">
                  <button type="button" onClick={() => handleToggleSelect(med.id)} className="mt-0.5 text-teal-700">
                    {isSelected ? <CheckSquare className="w-5 h-5 text-teal-700" /> : <Square className="w-5 h-5 text-slate-300" />}
                  </button>
                  <div className="min-w-0">
                    <h4 className="font-bold text-slate-900 text-sm">{med.name}</h4>
                    <div className="text-xs text-slate-500 mt-0.5">
                      المتبقي: <strong className="font-mono text-slate-700">{med.currentPills}</strong> • ينفد {depletion.formattedArabic}
                    </div>
                    <span
                      className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-lg border ${
                        status === 'out_of_stock'
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : status === 'critical'
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : status === 'warning'
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {status === 'out_of_stock' ? 'نفد' : status === 'critical' ? 'حرج' : status === 'warning' ? 'تنبيه' : 'آمن'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleDirectQuantityChange(med.id, Math.max(1, suggestedPills - boxStep))}
                    className="w-7 h-7 rounded-lg bg-slate-50 border border-slate-200 font-bold"
                  >
                    -
                  </button>
                  <div className="text-center">
                    <div className="font-mono font-bold text-sm">{suggestedPills}</div>
                    <div className="text-[9px] text-slate-400">{med.unit}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDirectQuantityChange(med.id, suggestedPills + boxStep)}
                    className="w-7 h-7 rounded-lg bg-slate-50 border border-slate-200 font-bold"
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-teal-800">
                <span>
                  {describeOrderInBoxes(suggestedPills, med.stripsPerBox, med.pillsPerStrip, med.packageSize, med.unit)}
                </span>
                {isCustom && (
                  <button type="button" onClick={() => handleResetToAuto(med.id)} className="text-teal-700 font-bold inline-flex items-center gap-0.5">
                    <RotateCcw className="w-3 h-3" /> تلقائي
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
