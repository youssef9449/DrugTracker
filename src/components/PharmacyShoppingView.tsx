import { useState, useMemo, useEffect, type FC } from 'react';
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
  PlusCircle,
  Layers,
  Box,
  Pill,
  ExternalLink,
  X,
  MessageSquare,
} from 'lucide-react';
import { Medication, PharmacySettings, calculateMedicationStatus, describeOrderInBoxes } from '../types';
import { pluralizeArabic } from '../lib/arabicPlural';
import { getDepletionDate, effectiveCurrentPills } from '../utils/dateCalculations';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  openWhatsAppLink,
  OrderItem,
  calculateMedicationOrderQuantity,
  buildWhatsAppUrl,
} from '../utils/whatsapp';

interface PharmacyShoppingViewProps {
  medications: Medication[];
  settings: PharmacySettings;
  onUpdateSettings: (newSettings: PharmacySettings) => void;
  onOpenSettings: (orderItems?: OrderItem[]) => void;
  onConfirmRefill: (medicationId: string, addedPills: number) => void;
  onUndoRefill?: (medicationId: string) => void;
  showToast: (message: string) => void;
}

export const PharmacyShoppingView: FC<PharmacyShoppingViewProps> = ({
  medications,
  settings,
  onUpdateSettings,
  onOpenSettings,
  onConfirmRefill,
  onUndoRefill,
  showToast,
}) => {
  const [durationDays, setDurationDays] = useState<30 | 60>(settings.defaultDurationDays || 30);
  const pharmacies = settings.pharmacies || [];
  const selectedPharmacy = pharmacies.find((pharmacy) => pharmacy.id === settings.selectedPharmacyId)
    || pharmacies[0]
    || (settings.pharmacyPhone || settings.pharmacyName || settings.customerCode
      ? { id: 'legacy', name: settings.pharmacyName || 'الصيدلية', phone: settings.pharmacyPhone || '', customerCode: settings.customerCode || '' }
      : undefined);

  useEffect(() => {
    if (settings.defaultDurationDays) setDurationDays(settings.defaultDurationDays);
  }, [settings.defaultDurationDays]);

  const [copied, setCopied] = useState(false);
  const [showAllForPlanning, setShowAllForPlanning] = useState(false);
  const [showPreviewMessage, setShowPreviewMessage] = useState(false);
  // Per-med order unit selector: 'pills' | 'boxes' | 'strips'.
  // Stored per med id so the user's choice persists within the session.
  type OrderUnit = 'pills' | 'boxes' | 'strips';
  const [orderUnits, setOrderUnits] = useState<Record<string, OrderUnit[]>>({});
  const [orderUnitQuantities, setOrderUnitQuantities] = useState<Record<string, Partial<Record<OrderUnit, number>>>>({});
  // Track which meds the user has just marked as refilled from this
  // view (so we can show a "تمت التعبئة" confirmation chip + let them
  // undo by tapping again if they tapped by mistake).
  const [refilledIds, setRefilledIds] = useState<Set<string>>(new Set());
  const [refilledQuantities, setRefilledQuantities] = useState<Record<string, number>>({});
  // #20: track meds the user explicitly DESELECTED so the
  // reconciliation effect doesn't silently re-select them when
  // `displayList` changes. Cleared for a med when it leaves
  // `displayList` (so it starts fresh if it returns).
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set());

  const urgentMeds = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning' || refilledIds.has(m.id);
    });
  }, [medications, refilledIds]);

  const effectiveShowAll = showAllForPlanning;
  const displayList = effectiveShowAll ? medications : urgentMeds;

  const [selectedMedIds, setSelectedMedIds] = useState<Set<string>>(() => {
    return new Set(urgentMeds.map((m) => m.id));
  });

  // #20 + #34: reconcile the selection AND the refilledIds/deselectedIds
  // against the displayed list. This effect:
  //   - Auto-selects any displayed med not yet selected AND not in
  //     `deselectedIds` (so manual deselects are preserved — #20).
  //   - Prunes ids that are no longer displayed from `selectedMedIds`,
  //     `deselectedIds`, and `refilledIds` (so deleted meds don't linger
  //     and returning meds start fresh — #34).
  // Each updater returns the SAME Set reference when nothing changed
  // so React skips the re-render (avoids an infinite loop since
  // `deselectedIds` is in the deps array).
  useEffect(() => {
    const displayedIds = new Set(displayList.map((m) => m.id));

    setSelectedMedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const m of displayList) {
        if (!next.has(m.id) && !deselectedIds.has(m.id)) { next.add(m.id); changed = true; }
      }
      for (const id of next) {
        if (!displayedIds.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });

    setRefilledIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of next) {
        if (!displayedIds.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
    setRefilledQuantities((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (!displayedIds.has(id)) { delete next[id]; changed = true; }
      }
      return changed ? next : prev;
    });

    setDeselectedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of next) {
        if (!displayedIds.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [displayList, deselectedIds]);

  const handleToggleSelect = (id: string) => {
    setSelectedMedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // #20: record the explicit deselect.
        setDeselectedIds((d) => new Set(d).add(id));
      } else {
        next.add(id);
        // #20: clear the deselect record on re-select.
        setDeselectedIds((d) => {
          const n = new Set(d);
          n.delete(id);
          return n;
        });
      }
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

  const handleResetToAuto = (medId: string) => {
    const nextCustom = { ...settings.customQuantities };
    delete nextCustom[medId];
    onUpdateSettings({ ...settings, customQuantities: nextCustom });
  };

  // ── Unit-aware quantity helpers ──────────────────────────────
  // The user picks an order unit (pills/boxes/strips) and a quantity
  // in that unit. We convert to the total pill count for storage in
  // customQuantities and for describeOrderInBoxes.

  /** Get the med's packaging constants. */
  function getMedSizes(med: Medication) {
    const isSolid = med.unit === 'قرص' || med.unit === 'كبسولة';
    const hasStrips = isSolid && Boolean(
      med.stripsPerBox &&
      med.pillsPerStrip &&
      med.stripsPerBox > 0 &&
      med.pillsPerStrip > 0
    );
    const boxSize =
      hasStrips
        ? med.stripsPerBox! * med.pillsPerStrip!
        : med.packageSize && med.packageSize > 0
        ? med.packageSize
        : med.unit === 'مل'
        ? 100
        : 30;
    const stripSize = hasStrips && med.pillsPerStrip && med.pillsPerStrip > 0 ? med.pillsPerStrip : 0;
    return { boxSize, stripSize, hasStrips, isSolid };
  }

  /** Available order units for a med: pills always, boxes if boxSize
   *  is known, strips only if the med has strips. */
  function getAvailableUnits(med: Medication): Array<'pills' | 'boxes' | 'strips'> {
    const { boxSize, stripSize, hasStrips } = getMedSizes(med);
    const units: Array<'pills' | 'boxes' | 'strips'> = ['boxes'];
    if (boxSize <= 0) return units;
    if (hasStrips && stripSize > 0) units.push('strips');
    return units;
  }

  /** Convert the selected unit's quantity → pills. */
  function unitQtyToPills(qty: number, unit: 'pills' | 'boxes' | 'strips', med: Medication): number {
    const { boxSize, stripSize } = getMedSizes(med);
    if (unit === 'boxes') return qty * boxSize;
    if (unit === 'strips') return qty * stripSize;
    return qty;
  }

  function getSelectedUnits(med: Medication): OrderUnit[] {
    return orderUnits[med.id] || ['boxes'];
  }

  function getUnitQuantity(med: Medication, unit: OrderUnit, suggestedPills: number): number {
    const saved = orderUnitQuantities[med.id]?.[unit];
    if (saved !== undefined) return saved;
    const { boxSize, stripSize } = getMedSizes(med);
    if (unit === 'boxes') return Math.max(1, Math.round(suggestedPills / boxSize));
    if (unit === 'strips') return Math.max(1, Math.round(suggestedPills / stripSize));
    return 0;
  }

  function getRequestedPills(med: Medication, suggestedPills: number): number {
    return getSelectedUnits(med).reduce(
      (total, unit) => total + unitQtyToPills(getUnitQuantity(med, unit, suggestedPills), unit, med),
      0
    );
  }

  const handleToggleOrderUnit = (med: Medication, unit: OrderUnit, suggestedPills: number) => {
    setOrderUnits((prev) => {
      const current = prev[med.id] || ['boxes'];
      const next = current.includes(unit) ? current.filter((item) => item !== unit) : [...current, unit];
      if (next.length === 0) return { ...prev, [med.id]: ['boxes'] };
      return { ...prev, [med.id]: next };
    });
    if (!getSelectedUnits(med).includes(unit)) {
      setOrderUnitQuantities((prev) => ({
        ...prev,
        [med.id]: {
          ...prev[med.id],
          ...Object.fromEntries(getSelectedUnits(med).map((selectedUnit) => [
            selectedUnit,
            getUnitQuantity(med, selectedUnit, suggestedPills),
          ])),
          [unit]: unit === 'pills' ? suggestedPills : 1,
        },
      }));
    }
  };

  const handleOrderUnitQuantityChange = (med: Medication, unit: OrderUnit, quantity: number, suggestedPills: number) => {
    const nextQuantity = Math.max(1, quantity || 1);
    setOrderUnitQuantities((prev) => ({ ...prev, [med.id]: { ...prev[med.id], [unit]: nextQuantity } }));
    const totalPills = getSelectedUnits(med).reduce(
      (total, selectedUnit) => total + unitQtyToPills(
        selectedUnit === unit ? nextQuantity : getUnitQuantity(med, selectedUnit, suggestedPills),
        selectedUnit,
        med
      ),
      0
    );
    const monthsMultiplier = durationDays === 60 ? 2 : 1;
    onUpdateSettings({
      ...settings,
      customQuantities: { ...settings.customQuantities, [med.id]: Math.max(1, Math.round(totalPills / monthsMultiplier)) },
    });
  };

  /** Display label for a unit. */
  function unitLabel(unit: 'pills' | 'boxes' | 'strips', med: Medication, count: number): string {
    if (unit === 'pills') return pluralizeArabic(count, med.unit);
    if (unit === 'boxes') {
      const boxName = med.unit === 'مل' ? 'عبوة' : 'علبة';
      return pluralizeArabic(count, boxName);
    }
    return pluralizeArabic(count, 'شريط');
  }

  // H1: "mark as refilled after ordering" flow. After the user sends
  // the WhatsApp order and receives the meds from the pharmacy, they
  // tap "تعبئة" on a med's card. This adds the ORDERED quantity to
  // that med's stock via the shared onConfirmRefill handler (which
  // creates a refill log + updates inventory), and marks the card
  // as refilled so the UI confirms the action. If the med was
  // previously refilled from this view, tapping again is a no-op
  // (the confirmation chip just stays).
  const handleMarkRefilled = (med: Medication, orderedQty: number) => {
    if (orderedQty <= 0) return;
    onConfirmRefill(med.id, orderedQty);
    setRefilledIds((prev) => new Set(prev).add(med.id));
    setRefilledQuantities((prev) => ({ ...prev, [med.id]: orderedQty }));
    showToast(`تمت تعبئة "${med.name}" بـ ${orderedQty} ${med.unit} في المخزون.`);
  };

  const activeOrderItems = useMemo((): OrderItem[] => {
    return displayList
      .filter((med) => selectedMedIds.has(med.id))
      .map((med) => {
        const { quantity: suggestedPills } = calculateMedicationOrderQuantity(med, durationDays, settings.customQuantities);
        return {
          name: med.name,
          quantity: getRequestedPills(med, suggestedPills),
          unit: med.unit,
          stripsPerBox: med.stripsPerBox,
          pillsPerStrip: med.pillsPerStrip,
          packageSize: med.packageSize,
        };
      });
  }, [displayList, selectedMedIds, settings.customQuantities, durationDays]);

  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const orderItemsForMessage = useMemo((): OrderItem[] => {
    if (activeOrderItems.length > 0) return activeOrderItems;
    return medications.map((med) => {
      const { quantity } = calculateMedicationOrderQuantity(
        med,
        settings.defaultDurationDays,
        settings.customQuantities
      );
      return {
        name: med.name,
        quantity,
        unit: med.unit,
        stripsPerBox: med.stripsPerBox,
        pillsPerStrip: med.pillsPerStrip,
        packageSize: med.packageSize,
      };
    });
  }, [activeOrderItems, medications, settings.defaultDurationDays, settings.customQuantities]);

  const currentWhatsAppMessage = useMemo(() => {
    return generatePharmacyOrderMessage(
      orderItemsForMessage,
      selectedPharmacy?.customerCode || '',
      settings.address,
      settings.contactPhone
    );
  }, [orderItemsForMessage, selectedPharmacy?.customerCode, settings.address, settings.contactPhone]);

  const hasPharmacyPhone = Boolean(selectedPharmacy?.phone?.trim());
  const displayPhone = selectedPharmacy?.phone ? cleanPhoneNumber(selectedPharmacy.phone) : '';
  const selectedCount = activeOrderItems.length;

  const targetWaUrl = useMemo(() => {
    return buildWhatsAppUrl(selectedPharmacy?.phone || '', currentWhatsAppMessage);
  }, [selectedPharmacy?.phone, currentWhatsAppMessage]);

  const handleSendToWhatsApp = () => {
    if (selectedCount === 0) {
      showToast('يرجى تحديد دواء واحد على الأقل لإرسال الطلب.');
      return;
    }
    if (!selectedPharmacy?.phone?.trim()) {
      setIsSendModalOpen(true);
      showToast('أضف صيدلية من تبويب الصيدليات أولًا.');
      return;
    }
    // Let the user choose the destination pharmacy in the confirmation modal
    // before opening WhatsApp.
    setIsSendModalOpen(true);
    showToast('اختر الصيدلية ثم افتح واتساب لإرسال الطلب.');
  };

  const handleCopyOrder = async () => {
    if (!currentWhatsAppMessage) {
      showToast('يرجى تحديد دواء واحد على الأقل لنسخ الطلب.');
      return;
    }
    try {
      await navigator.clipboard.writeText(currentWhatsAppMessage);
      setCopied(true);
      showToast('تم نسخ رسالة الواتساب بنجاح!');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      showToast('تعذر النسخ التلقائي.');
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="bg-white rounded-2xl border border-slate-200/90 p-3.5 shadow-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">
            <Phone className="w-4 h-4" />
          </div>
          <div className="min-w-0 text-xs">
            <div className="flex items-center gap-1.5 flex-wrap">
              <select
                value={selectedPharmacy?.id || ''}
                onChange={(event) => onUpdateSettings({ ...settings, selectedPharmacyId: event.target.value })}
                className="max-w-[180px] bg-transparent font-bold text-slate-800 truncate outline-none"
                aria-label="اختيار الصيدلية"
              >
                {pharmacies.length === 0 && <option value="">اختر صيدلية</option>}
                {pharmacies.map((pharmacy) => <option key={pharmacy.id} value={pharmacy.id}>{pharmacy.name}</option>)}
                {pharmacies.length === 0 && selectedPharmacy && <option value="legacy">{selectedPharmacy.name}</option>}
              </select>
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
              كود العميل:{' '}
              {selectedPharmacy?.customerCode?.trim() ? (
                <strong className="text-teal-800 font-mono">{selectedPharmacy.customerCode.trim()}</strong>
              ) : (
                <span className="text-slate-400 font-normal">غير محدد (اختياري)</span>
              )}
            </div>
          </div>
        </div>
        <button onClick={() => onOpenSettings(activeOrderItems)} className="shrink-0 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5">
          <Settings className="w-3.5 h-3.5" /> تعديل
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
        {/* Post-order hint (H1): explain the "mark as refilled" flow so
            the user knows to come back here after picking up the order. */}
        <div className="flex items-start gap-2 bg-teal-50 border border-teal-200/80 rounded-xl px-3 py-2 text-[11px] text-teal-900 leading-relaxed">
          <PlusCircle className="w-3.5 h-3.5 text-teal-600 shrink-0 mt-0.5" />
          <span>
            بعد استلام الأدوية من الصيدلية، اضغط زر <strong>«تعبئة»</strong> بجانب كل دواء بالأسفل
            لإضافة الكمية المطلوبة تلقائياً إلى مخزونك (يُسجّل كعملية تعبئة في السجل).
          </span>
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
          <div className="p-3 bg-slate-50 text-slate-700 rounded-xl border border-slate-200 shadow-sm text-xs font-mono whitespace-pre-line leading-relaxed">
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
          <button
            onClick={() => {
              setSelectedMedIds(new Set(displayList.map((m) => m.id)));
              // #20: clearing deselects — all are selected.
              setDeselectedIds(new Set());
            }}
            className="text-teal-700 font-bold"
          >
            تحديد الكل
          </button>
          <button
            onClick={() => {
              setSelectedMedIds(new Set());
              // #20: record all displayed meds as deselected so the
              // reconciliation effect doesn't silently re-select them.
              setDeselectedIds(new Set(displayList.map((m) => m.id)));
            }}
            className="text-slate-500"
          >
            إلغاء
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {displayList.map((med) => {
          const { status } = calculateMedicationStatus(med);
          const { quantity: suggestedPills, isCustom } = getRequestedAmount(med);
          const requestedPills = getRequestedPills(med, suggestedPills);
          const depletion = getDepletionDate(med);
          const isSelected = selectedMedIds.has(med.id);
          const { boxSize } = getMedSizes(med);
          const availableUnits = getAvailableUnits(med);
          const selectedUnits = getSelectedUnits(med);
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
                      المتبقي: <strong className="font-mono text-slate-700">{effectiveCurrentPills(med)}</strong> • ينفد {depletion.formattedArabic}
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
              </div>

              {/* Unit selector + quantity input */}
              <div className="mt-3 space-y-2">
                {/* Unit selector chips */}
                {availableUnits.length > 1 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {availableUnits.map((u) => {
                      const isActive = selectedUnits.includes(u);
                      const icon = u === 'pills' ? <Pill className="w-3 h-3" /> : u === 'boxes' ? <Box className="w-3 h-3" /> : <Layers className="w-3 h-3" />;
                      const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
                      const label = u === 'pills' ? med.unit : u === 'boxes' ? boxLabel : 'شريط';
                      return (
                        <button
                          key={u}
                          type="button"
                          onClick={() => handleToggleOrderUnit(med, u, suggestedPills)}
                          className={`px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 transition ${
                            isActive
                              ? 'bg-teal-700 text-white'
                              : 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {icon}
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="space-y-2">
                  {selectedUnits.map((unit) => {
                    const unitQty = getUnitQuantity(med, unit, suggestedPills);
                    const unitStep = unit === 'pills' ? boxSize : 1;
                    return (
                      <div key={unit} className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-slate-500 font-bold">{unitLabel(unit, med, unitQty)}</span>
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => handleOrderUnitQuantityChange(med, unit, unitQty - unitStep, suggestedPills)} className="w-7 h-7 rounded-lg bg-slate-50 border border-slate-200 font-bold">-</button>
                          <input
                            type="number"
                            min="1"
                            value={unitQty}
                            onChange={(e) => handleOrderUnitQuantityChange(med, unit, parseInt(e.target.value, 10) || 1, suggestedPills)}
                            className="w-16 px-2 py-1 text-center font-mono font-bold text-sm border border-slate-200 rounded-lg focus:ring-1 focus:ring-teal-500"
                          />
                          <button type="button" onClick={() => handleOrderUnitQuantityChange(med, unit, unitQty + unitStep, suggestedPills)} className="w-7 h-7 rounded-lg bg-slate-50 border border-slate-200 font-bold">+</button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="text-[11px] text-teal-800 text-left">
                    الإجمالي: {describeOrderInBoxes(requestedPills, med.stripsPerBox, med.pillsPerStrip, med.packageSize, med.unit)}
                  </div>
                </div>

                {isCustom && (
                  <button type="button" onClick={() => handleResetToAuto(med.id)} className="text-teal-700 font-bold inline-flex items-center gap-0.5 text-[11px]">
                    <RotateCcw className="w-3 h-3" /> تلقائي
                  </button>
                )}
              </div>

              {/* H1: "mark as refilled after ordering" action. */}
              <div className="mt-2.5">
                {refilledIds.has(med.id) ? (
                  <div className="w-full py-2 px-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold flex items-center justify-center gap-1.5">
                    <Check className="w-4 h-4" />
                    <span>تمت التعبئة (+{refilledQuantities[med.id] || requestedPills} {med.unit} في المخزون)</span>
                    {onUndoRefill && (
                      <button type="button" onClick={() => { onUndoRefill(med.id); setRefilledIds((prev) => { const next = new Set(prev); next.delete(med.id); return next; }); setRefilledQuantities((prev) => { const next = { ...prev }; delete next[med.id]; return next; }); }} className="text-rose-700 underline mr-2">تراجع</button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleMarkRefilled(med, requestedPills)}
                    className="w-full py-2 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98"
                    title="إضافة الكمية المطلوبة إلى مخزون هذا الدواء"
                  >
                    <PlusCircle className="w-4 h-4 text-teal-600" />
                    <span>تعبئة (+{requestedPills} {med.unit})</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* WhatsApp Send Confirmation & Direct Links Modal */}
      {isSendModalOpen && (
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
                onClick={() => setIsSendModalOpen(false)}
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
                    <option value="legacy">{selectedPharmacy.name}</option>
                  )}
                </select>
              </label>
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-700 flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-teal-600" />
                  <span>{selectedPharmacy?.name || 'لم يتم اختيار صيدلية'}:</span>
                </span>
              </div>
              <div className="flex items-center justify-between bg-white px-3 py-2 rounded-xl border border-slate-200">
                <span className="text-xs text-slate-500">رقم واتساب:</span>
                <span className="font-mono text-xs font-bold text-teal-900" dir="ltr">
                  {hasPharmacyPhone ? `+${displayPhone}` : 'غير متاح'}
                </span>
              </div>
            </div>

            {/* Direct Send Action Buttons */}
            {hasPharmacyPhone && (
              <div className="space-y-2">
                <a
                  href={targetWaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    openWhatsAppLink(selectedPharmacy?.phone || '', currentWhatsAppMessage);
                    showToast('تم فتح واتساب!');
                  }}
                  className="w-full py-3 px-4 bg-[#25D366] hover:bg-[#20bd5a] text-white rounded-2xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2.5 shadow-md active:scale-98 transition text-center"
                >
                  <MessageCircle className="w-5 h-5 shrink-0" />
                  <span>فتح محادثة واتساب الآن 🚀</span>
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
                  return (
                    <div key={idx} className="flex items-center justify-between py-1 border-b border-slate-200/60 last:border-b-0">
                      <span className="font-bold text-slate-800">{item.name}</span>
                      <span className="text-[11px] text-teal-800 bg-teal-50 px-2 py-0.5 rounded-lg border border-teal-200/60 font-semibold">
                        {pkg || `${item.quantity} ${item.unit}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Friendly Refill Reminder */}
            <div className="flex items-start gap-2 bg-teal-50/80 border border-teal-200/70 rounded-xl p-2.5 text-[11px] text-teal-900 leading-relaxed">
              <PlusCircle className="w-4 h-4 text-teal-600 shrink-0 mt-0.5" />
              <span>
                تذكير: بعد وصول الأدوية واستلامها من الصيدلية، اضغط زر <strong>«تعبئة»</strong> بجانب كل دواء في صفحة الشراء لتحديث المخزون تلقائياً.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
