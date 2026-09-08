import React, { useState, useMemo, useEffect } from 'react';
import {
  ShoppingCart,
  Copy,
  Check,
  Share2,
  Settings,
  Phone,
  CheckCircle2,
  ExternalLink,
  MessageCircle,
  Plus,
  Minus,
  AlertTriangle,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronUp,
  RotateCcw,
} from 'lucide-react';
import { Medication, PharmacySettings, calculateMedicationStatus, describeOrderInBoxes } from '../types';
import { getDepletionDate } from '../utils/dateCalculations';
import {
  buildWhatsAppUrl,
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
  onConfirmRefill,
  showToast,
}) => {
  const [durationDays, setDurationDays] = useState<30 | 60>(
    settings.defaultDurationDays || 30
  );

  // Synchronize when settings change (e.g. from the modal)
  useEffect(() => {
    if (settings.defaultDurationDays) {
      setDurationDays(settings.defaultDurationDays);
    }
  }, [settings.defaultDurationDays]);

  const [copied, setCopied] = useState(false);
  const [showAllForPlanning, setShowAllForPlanning] = useState(false);
  const [showPreviewMessage, setShowPreviewMessage] = useState(false);

  // Filter urgent vs all
  const urgentMeds = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    });
  }, [medications]);

  // If there are no urgent meds, default to showing all medications so the screen is never blank
  const effectiveShowAll = showAllForPlanning || urgentMeds.length === 0;
  const displayList = effectiveShowAll ? medications : urgentMeds;

  // Selected med IDs to include in WhatsApp message
  const [selectedMedIds, setSelectedMedIds] = useState<Set<string>>(() => {
    // By default, select all urgent meds if any exist, otherwise select all meds
    const initialList = urgentMeds.length > 0 ? urgentMeds : medications;
    return new Set(initialList.map((m) => m.id));
  });

  // Toggle med selection
  const handleToggleSelect = (id: string) => {
    setSelectedMedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedMedIds(new Set(displayList.map((m) => m.id)));
  };

  const handleDeselectAll = () => {
    setSelectedMedIds(new Set());
  };

  // Duration change handler that persists default setting and updates quantities immediately
  const handleDurationChange = (newDuration: 30 | 60) => {
    setDurationDays(newDuration);
    onUpdateSettings({
      ...settings,
      defaultDurationDays: newDuration,
    });
    showToast(
      newDuration === 60
        ? 'تم التبديل لتغطية شهرين (60 يوم) - تضاعفت الكميات المطلوبة'
        : 'تم التبديل لتغطية شهر (30 يوم) - احتساب كميات شهر واحد'
    );
  };

  // Calculate or retrieve needed quantity for a medication based on duration
  const getRequestedAmount = (med: Medication) => {
    const res = calculateMedicationOrderQuantity(
      med,
      durationDays,
      settings.customQuantities
    );
    return {
      suggestedPills: res.quantity,
      isCustom: res.isCustom,
      baseMonthlyQuantity: res.baseMonthlyQuantity,
    };
  };

  // Adjust quantity directly from shopping list
  const handleDirectQuantityChange = (medId: string, newDisplayQty: number) => {
    const monthsMultiplier = durationDays === 60 ? 2 : 1;
    const baseMonthly = Math.max(1, Math.round(newDisplayQty / monthsMultiplier));
    const updatedCustom = {
      ...settings.customQuantities,
      [medId]: baseMonthly,
    };
    onUpdateSettings({
      ...settings,
      customQuantities: updatedCustom,
    });
  };

  // Reset custom quantity override back to automatic calculation
  const handleResetToAuto = (medId: string) => {
    const nextCustom = { ...settings.customQuantities };
    delete nextCustom[medId];
    onUpdateSettings({
      ...settings,
      customQuantities: nextCustom,
    });
    showToast('تمت استعادة الحساب التلقائي للكمية');
  };

  // Generate WhatsApp message with all selected medications
  const generateWhatsAppMessage = (): string => {
    const itemsToOrder: OrderItem[] = displayList
      .filter((med) => selectedMedIds.has(med.id))
      .map((med) => {
        const { suggestedPills } = getRequestedAmount(med);
        return {
          name: med.name,
          quantity: suggestedPills,
          unit: med.unit,
          stripsPerBox: med.stripsPerBox,
          pillsPerStrip: med.pillsPerStrip,
          packageSize: med.packageSize,
        };
      });

    if (itemsToOrder.length === 0) return '';
    return generatePharmacyOrderMessage(itemsToOrder, settings.customerCode || '14739');
  };

  // Direct Send to Pharmacy WhatsApp
  const handleSendToWhatsApp = () => {
    if (!settings.pharmacyPhone || !settings.pharmacyPhone.trim()) {
      showToast('يرجى إدخال رقم هاتف الصيدلية أولاً في الإعدادات لإرسال الرسالة.');
      onOpenSettings();
      return;
    }

    const message = generateWhatsAppMessage();
    if (!message) {
      showToast('يرجى تحديد دواء واحد على الأقل لإرسال الطلب.');
      return;
    }

    openWhatsAppLink(settings.pharmacyPhone, message);
    const clean = cleanPhoneNumber(settings.pharmacyPhone);
    showToast(`جاري فتح محادثة الصيدلية على واتساب (${clean})...`);
  };

  // Copy WhatsApp message to clipboard
  const handleCopyOrder = async () => {
    const orderText = generateWhatsAppMessage();
    if (!orderText) {
      showToast('يرجى تحديد دواء واحد على الأقل لنسخ الطلب.');
      return;
    }

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(orderText);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = orderText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      showToast('تم نسخ رسالة الواتساب بنجاح!');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      showToast('تعذر النسخ التلقائي.');
    }
  };

  const hasPharmacyPhone = Boolean(settings.pharmacyPhone && settings.pharmacyPhone.trim());
  const displayPhone = settings.pharmacyPhone ? cleanPhoneNumber(settings.pharmacyPhone) : '';
  const selectedCount = displayList.filter((m) => selectedMedIds.has(m.id)).length;
  const currentWhatsAppMessage = generateWhatsAppMessage();


  return (
    <div className="p-4 space-y-4">
      {/* Pharmacy Profile & Settings Banner */}
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-xs flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <Phone className="w-4 h-4" />
          </div>
          <div className="min-w-0 text-xs">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-slate-800 truncate">
                {settings.pharmacyName || 'الصيدلية'}
              </span>
              {hasPharmacyPhone ? (
                <span className="font-mono text-[11px] bg-teal-50 text-teal-800 px-2 py-0.5 rounded-md border border-teal-200 font-bold">
                  +{displayPhone}
                </span>
              ) : (
                <span className="text-[10px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200 font-medium">
                  ⚠️ اكتب رقم الصيدلية لإرسال الطلب
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              رقم العميل في رسالة الواتساب:{' '}
              <strong className="text-teal-800 font-mono font-bold">
                {settings.customerCode || '14739'}
              </strong>
            </div>
          </div>
        </div>

        {/* Edit Settings Button */}
        <button
          onClick={onOpenSettings}
          className="shrink-0 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 transition active:scale-95"
        >
          <Settings className="w-3.5 h-3.5 text-slate-600" />
          <span>{hasPharmacyPhone ? 'تعديل الإعدادات' : 'إضافة رقم الصيدلية'}</span>
        </button>
      </div>

      {/* Main Action Bar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              قائمة الشراء وتجهيز طلب الصيدلية
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              تُدرج أسماء الأدوية والكميات تلقائياً وتُرسل مباشرة لواتساب الصيدلية
            </p>
          </div>
        </div>

        {/* Buttons: Direct Send to WhatsApp & Copy */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {/* WhatsApp Send Button */}
          <button
            onClick={handleSendToWhatsApp}
            disabled={selectedCount === 0}
            className={`w-full py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-xs transition active:scale-98 ${
              selectedCount === 0
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-[#25D366] hover:bg-[#20ba59] text-white'
            }`}
          >
            <MessageCircle className="w-4 h-4 fill-white text-[#25D366]" />
            <span>
              إرسال مباشرة لواتساب الصيدلية ({selectedCount})
            </span>
          </button>

          {/* Copy Button */}
          <button
            onClick={handleCopyOrder}
            disabled={selectedCount === 0}
            className={`w-full py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 border ${
              selectedCount === 0
                ? 'bg-slate-50 text-slate-400 border-slate-200 cursor-not-allowed'
                : copied
                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200'
            }`}
          >
            {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4 text-slate-500" />}
            <span>{copied ? 'تم نسخ الرسالة!' : 'نسخ نص الرسالة'}</span>
          </button>
        </div>

        {/* Collapsible WhatsApp Message Preview */}
        <div className="border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={() => setShowPreviewMessage(!showPreviewMessage)}
            className="w-full flex items-center justify-between text-xs text-slate-600 hover:text-teal-800 py-1 font-medium transition"
          >
            <span className="flex items-center gap-1.5">
              <span>معاينة نص الرسالة التي ستُرسل لواتساب الصيدلية</span>
              <span className="text-[11px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono">
                {selectedCount} دواء
              </span>
            </span>
            {showPreviewMessage ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showPreviewMessage && (
            <div className="mt-2 p-3 bg-slate-900 text-slate-100 rounded-xl text-xs font-mono whitespace-pre-line leading-relaxed border border-slate-800 select-text">
              {currentWhatsAppMessage || 'يرجى تحديد أدوية لمعاينة نص الرسالة.'}
            </div>
          )}
        </div>

        {/* Duration selector & filter toggle */}
        <div className="pt-2 border-t border-slate-100 flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl">
            <button
              type="button"
              onClick={() => handleDurationChange(30)}
              className={`px-3 py-1.5 rounded-lg font-bold transition text-xs flex items-center gap-1.5 ${
                durationDays === 30
                  ? 'bg-teal-700 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 bg-white/70'
              }`}
            >
              <span>حساب شهر (30 يوم)</span>
              {durationDays === 30 && (
                <span className="w-1.5 h-1.5 rounded-full bg-teal-200"></span>
              )}
            </button>
            <button
              type="button"
              onClick={() => handleDurationChange(60)}
              className={`px-3 py-1.5 rounded-lg font-bold transition text-xs flex items-center gap-1.5 ${
                durationDays === 60
                  ? 'bg-teal-700 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 bg-white/70'
              }`}
            >
              <span>حساب شهرين (60 يوم)</span>
              {durationDays === 60 && (
                <span className="w-1.5 h-1.5 rounded-full bg-teal-200"></span>
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAllForPlanning(!showAllForPlanning)}
              className="text-teal-700 hover:text-teal-900 font-bold underline text-[11px]"
            >
              {showAllForPlanning ? 'عرض النواقص العاجلة فقط' : 'عرض وتجهيز كل الأدوية'}
            </button>
          </div>
        </div>
      </div>

      {/* Main List Header with Select All / Deselect All */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs px-1">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-700">
              الأدوية المتاحة للطلب:
            </span>
            <span className="text-slate-500 font-mono text-[11px]">
              ({selectedCount} محدد من {displayList.length})
            </span>
            <span className="text-[10px] bg-teal-50 text-teal-800 border border-teal-200/80 px-2 py-0.5 rounded-md font-bold">
              {durationDays === 60 ? 'تغطية شهرين (مضاعفة)' : 'تغطية شهر واحد'}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <button
              onClick={handleSelectAll}
              className="text-teal-700 hover:underline font-bold"
            >
              تحديد الكل
            </button>
            <span>•</span>
            <button
              onClick={handleDeselectAll}
              className="text-slate-500 hover:underline"
            >
              إلغاء التحديد
            </button>
          </div>
        </div>

        {displayList.map((med) => {
          const { status } = calculateMedicationStatus(med);
          const { suggestedPills, isCustom } = getRequestedAmount(med);
          const depletion = getDepletionDate(med);
          const isSelected = selectedMedIds.has(med.id);

          return (
            <div
              key={med.id}
              className={`bg-white rounded-2xl border p-3.5 shadow-xs transition ${
                isSelected
                  ? 'border-teal-300 ring-1 ring-teal-100'
                  : 'border-slate-200/80 opacity-75'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2.5">
                  {/* Selection Checkbox */}
                  <button
                    type="button"
                    onClick={() => handleToggleSelect(med.id)}
                    className="mt-0.5 text-teal-700 hover:scale-105 transition"
                    title={isSelected ? 'إلغاء إدراج هذا الدواء في الرسالة' : 'إدراج هذا الدواء في الرسالة'}
                  >
                    {isSelected ? (
                      <CheckSquare className="w-5 h-5 text-teal-700 fill-teal-50" />
                    ) : (
                      <Square className="w-5 h-5 text-slate-300" />
                    )}
                  </button>

                  <div>
                    <h4 className="font-bold text-slate-900 text-sm">{med.name}</h4>
                    <div className="flex items-center gap-2 mt-0.5 text-xs">
                      <span className="text-slate-500">
                        المتبقي حالياً:{' '}
                        <strong className="font-mono text-slate-700">
                          {med.currentPills} {med.unit}
                        </strong>
                      </span>
                      <span>•</span>
                      <span className="text-slate-500">
                        الاستهلاك:{' '}
                        <strong className="font-mono text-teal-800">
                          {med.dailyDose} {med.unit}/يوم
                        </strong>
                      </span>
                    </div>
                  </div>
                </div>

                {/* Urgency Badge */}
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border shrink-0 ${
                    status === 'out_of_stock'
                      ? 'bg-red-50 text-red-700 border-red-200'
                      : status === 'critical'
                      ? 'bg-rose-50 text-rose-700 border-rose-200'
                      : status === 'warning'
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  }`}
                >
                  {status === 'out_of_stock' ? 'نفد تماماً' : `ينفد: ${depletion.formattedArabic}`}
                </span>
              </div>

              {/* Quantity Control & Refill action */}
              <div className="mt-3 p-2.5 bg-teal-50/50 rounded-xl border border-teal-100 flex items-center justify-between flex-wrap gap-2 text-xs">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-700 block text-[11px] font-bold">
                      الكمية المطلوبة ({durationDays === 60 ? 'تغطية شهرين' : 'تغطية شهر'}):
                    </span>
                    {isCustom && (
                      <button
                        type="button"
                        onClick={() => handleResetToAuto(med.id)}
                        className="text-[10px] text-teal-700 hover:text-teal-900 bg-teal-100 hover:bg-teal-200 px-1.5 py-0.5 rounded font-bold flex items-center gap-0.5 transition"
                        title="استعادة الحساب التلقائي"
                      >
                        <RotateCcw className="w-2.5 h-2.5" />
                        <span>مخصصة (إعادة ضبط)</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
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
                              handleDirectQuantityChange(
                                med.id,
                                Math.max(1, suggestedPills - boxStep)
                              )
                            }
                            className="w-6 h-6 rounded-md bg-white border border-teal-200 font-bold text-slate-700 hover:bg-slate-50 flex items-center justify-center active:scale-95"
                            title="تقليل بمقدار علبة"
                          >
                            <Minus className="w-3 h-3" />
                          </button>

                          <div className="flex items-center gap-1 bg-white px-2 py-0.5 rounded-md border border-teal-300">
                            <span className="text-sm font-extrabold font-mono text-teal-900">
                              {suggestedPills}
                            </span>
                            <span className="text-[11px] text-teal-800 font-medium">
                              {med.unit}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() =>
                              handleDirectQuantityChange(
                                med.id,
                                suggestedPills + boxStep
                              )
                            }
                            className="w-6 h-6 rounded-md bg-white border border-teal-200 font-bold text-slate-700 hover:bg-slate-50 flex items-center justify-center active:scale-95"
                            title="زيادة بمقدار علبة"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </>
                      );
                    })()}

                    <span className="text-xs font-bold text-teal-900 bg-teal-100 border border-teal-200 px-2 py-0.5 rounded-md">
                      {describeOrderInBoxes(
                        suggestedPills,
                        med.stripsPerBox,
                        med.pillsPerStrip,
                        med.packageSize,
                        med.unit
                      )}
                    </span>
                  </div>

                  {med.stripsPerBox && med.pillsPerStrip && (
                    <div className="mt-1 text-[10px] text-slate-500">
                      مواصفات العبوة: العلبة {med.stripsPerBox} أشرطة × {med.pillsPerStrip} {med.unit} ({med.stripsPerBox * med.pillsPerStrip} {med.unit})
                    </div>
                  )}
                </div>

                {/* Quick Refill after receiving pharmacy order */}
                <button
                  onClick={() => {
                    onConfirmRefill(med.id, suggestedPills);
                    setSelectedMedIds((prev) => {
                      const next = new Set(prev);
                      next.delete(med.id);
                      return next;
                    });
                    showToast(`تم تسجيل شراء وتعبئة ${suggestedPills} ${med.unit} لـ "${med.name}"`);
                  }}
                  className="px-3 py-1.5 bg-white hover:bg-emerald-50 text-emerald-700 border border-emerald-300 font-bold text-xs rounded-xl shadow-2xs flex items-center gap-1.5 transition active:scale-95"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>تم الشراء (+{suggestedPills})</span>
                </button>
              </div>
            </div>
          );
        })}

        {/* End of message note indicating customer code */}
        <div className="p-3 bg-slate-100 rounded-xl text-xs text-slate-600 border border-slate-200 flex items-center justify-between">
          <span>
            نهاية نص رسالة الواتساب المعتمدة:{' '}
            <strong className="text-teal-900 font-mono">
              رقم العميل {settings.customerCode || '14739'}
            </strong>
          </span>
          <button
            onClick={onOpenSettings}
            className="text-[11px] text-teal-700 hover:underline font-bold"
          >
            تعديل الرقم
          </button>
        </div>
      </div>
    </div>
  );
};
