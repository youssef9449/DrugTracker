import { useState, useMemo, useEffect, type FC } from 'react';
import {
  Phone,
  MessageCircle,
  CheckSquare,
  Square,
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
import { getMedSizes } from '../utils/medicationPackaging';

interface PharmacyShoppingViewProps {
  medications: Medication[];
  settings: PharmacySettings;
  onUpdateSettings: (newSettings: PharmacySettings) => void;
  showToast: (message: string) => void;
}

export const PharmacyShoppingView: FC<PharmacyShoppingViewProps> = ({
  medications,
  settings,
  onUpdateSettings,
  showToast,
}) => {
  type PeriodUnit = 'day' | 'month';
  type MedicationPeriod = { value: number; unit: PeriodUnit };
  type QuantityMode = 'period' | 'custom';
  const [medicationPeriods, setMedicationPeriods] = useState<Record<string, MedicationPeriod>>({});
  const [quantityModes, setQuantityModes] = useState<Record<string, QuantityMode>>({});
  const [customOrderQuantities, setCustomOrderQuantities] = useState<Record<string, number>>({});
  const pharmacies = settings.pharmacies || [];
  const selectedPharmacy = pharmacies.find((pharmacy) => pharmacy.id === settings.selectedPharmacyId)
    || pharmacies[0]
    || (settings.pharmacyPhone || settings.pharmacyName || settings.customerCode
      ? { id: 'legacy', name: settings.pharmacyName || 'الصيدلية', phone: settings.pharmacyPhone || '', customerCode: settings.customerCode || '' }
      : undefined);

  const [showAllForPlanning, setShowAllForPlanning] = useState(false);
  // Per-med order unit selector: 'pills' | 'boxes' | 'strips'.
  // Stored per med id so the user's choice persists within the session.
  type OrderUnit = 'pills' | 'boxes' | 'strips';
  const [orderUnits, setOrderUnits] = useState<Record<string, OrderUnit[]>>({});
  // #20: track meds the user explicitly DESELECTED so the
  // reconciliation effect doesn't silently re-select them when
  // `displayList` changes. Cleared for a med when it leaves
  // `displayList` (so it starts fresh if it returns).
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set());

  const urgentMeds = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    });
  }, [medications]);

  const effectiveShowAll = showAllForPlanning;
  const displayList = effectiveShowAll ? medications : urgentMeds;

  const [selectedMedIds, setSelectedMedIds] = useState<Set<string>>(() => {
    return new Set(urgentMeds.map((m) => m.id));
  });

  // #20 + #34: reconcile the selection and deselectedIds
  // against the displayed list. This effect:
  //   - Auto-selects any displayed med not yet selected AND not in
  //     `deselectedIds` (so manual deselects are preserved — #20).
  //   - Prunes ids that are no longer displayed from `selectedMedIds` and
  //     `deselectedIds`.
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
    // Read current values from the closure (not from setState updaters) and
    // compute both next states, then call both setters sequentially. The
    // previous version called setDeselectedIds from inside the
    // setSelectedMedIds updater — unsafe under React 18+ concurrent
    // rendering / StrictMode because updaters must be pure (audit #70).
    const nextSelected = new Set(selectedMedIds);
    const nextDeselected = new Set(deselectedIds);
    if (nextSelected.has(id)) {
      nextSelected.delete(id);
      // #20: record the explicit deselect.
      nextDeselected.add(id);
    } else {
      nextSelected.add(id);
      // #20: clear the deselect record on re-select.
      nextDeselected.delete(id);
    }
    setSelectedMedIds(nextSelected);
    setDeselectedIds(nextDeselected);
  };

  const getMedicationPeriod = (med: Medication): MedicationPeriod => medicationPeriods[med.id] || {
    value: settings.defaultDurationDays === 60 ? 2 : 30,
    unit: settings.defaultDurationDays === 60 ? 'month' : 'day',
  };

  const getDurationDays = (med: Medication) => {
    const period = getMedicationPeriod(med);
    return Math.max(1, period.value || 1) * (period.unit === 'month' ? 30 : 1);
  };

  const getQuantityMode = (med: Medication): QuantityMode => quantityModes[med.id] || 'period';

  const handleMedicationPeriodChange = (medId: string, field: keyof MedicationPeriod, value: string) => {
    const med = medications.find((item) => item.id === medId);
    if (!med) return;
    const nextPeriod = {
      ...getMedicationPeriod(med),
      [field]: field === 'value' ? Math.max(1, parseInt(value, 10) || 1) : value,
    } as MedicationPeriod;
    setMedicationPeriods((prev) => ({
      ...prev,
      [medId]: {
        ...nextPeriod,
      },
    }));
    if (settings.customQuantities[medId] !== undefined) {
      const nextCustom = { ...settings.customQuantities };
      delete nextCustom[medId];
      onUpdateSettings({ ...settings, customQuantities: nextCustom });
    }
  };

  const getRequestedAmount = (med: Medication) =>
    calculateMedicationOrderQuantity(med, getDurationDays(med));

  // ── Unit display helpers ─────────────────────────────────────
  // The selected unit only changes how the calculated quantity is shown.
  // It must never change the quantity required for the selected period.

  /** Available display units: boxes and strips when strip packaging exists. */
  function getAvailableUnits(med: Medication): Array<'pills' | 'boxes' | 'strips'> {
    const { boxSize, stripSize, hasStrips } = getMedSizes(med);
    const units: Array<'pills' | 'boxes' | 'strips'> = hasStrips ? ['strips'] : ['boxes'];
    if (boxSize <= 0) return units;
    if (hasStrips && stripSize > 0) units.push('boxes');
    return units;
  }

  function getSelectedUnits(med: Medication): OrderUnit[] {
    return orderUnits[med.id] || (getMedSizes(med).hasStrips ? ['strips'] : ['boxes']);
  }

  function unitToPills(quantity: number, unit: OrderUnit, med: Medication): number {
    const { boxSize, stripSize } = getMedSizes(med);
    if (unit === 'boxes') return quantity * boxSize;
    if (unit === 'strips') return quantity * stripSize;
    return quantity;
  }

  function getUnitQuantity(med: Medication, unit: OrderUnit, suggestedPills: number): number {
    const { boxSize, stripSize } = getMedSizes(med);
    if (getQuantityMode(med) === 'custom') {
      return customOrderQuantities[med.id] || Math.max(1, Math.ceil(suggestedPills / (unit === 'boxes' ? boxSize : stripSize)));
    }
    if (unit === 'boxes') return Math.max(1, Math.ceil(suggestedPills / boxSize));
    if (unit === 'strips') return Math.max(1, Math.ceil(suggestedPills / stripSize));
    return 0;
  }

  function getRequestedPills(med: Medication, suggestedPills: number): number {
    if (getQuantityMode(med) === 'custom') {
      const selectedUnit = getSelectedUnits(med)[0];
      return unitToPills(getUnitQuantity(med, selectedUnit, suggestedPills), selectedUnit, med);
    }
    return suggestedPills;
  }

  const handleToggleQuantityMode = (med: Medication, mode: QuantityMode, suggestedPills: number) => {
    setQuantityModes((prev) => ({ ...prev, [med.id]: mode }));
    if (mode === 'custom' && customOrderQuantities[med.id] === undefined) {
      const selectedUnit = getSelectedUnits(med)[0];
      const { boxSize, stripSize } = getMedSizes(med);
      const unitSize = selectedUnit === 'boxes' ? boxSize : stripSize;
      setCustomOrderQuantities((prev) => ({
        ...prev,
        [med.id]: Math.max(1, Math.ceil(suggestedPills / unitSize)),
      }));
    }
  };

  const handleToggleOrderUnit = (med: Medication, unit: OrderUnit, suggestedPills: number) => {
    const currentUnit = getSelectedUnits(med)[0];
    const currentQuantity = getQuantityMode(med) === 'custom'
      ? getUnitQuantity(med, currentUnit, suggestedPills)
      : Math.max(1, Math.ceil(suggestedPills / (currentUnit === 'boxes' ? getMedSizes(med).boxSize : getMedSizes(med).stripSize)));
    const currentPills = unitToPills(currentQuantity, currentUnit, med);
    const nextUnitSize = unit === 'boxes' ? getMedSizes(med).boxSize : getMedSizes(med).stripSize;
    setOrderUnits((prev) => ({ ...prev, [med.id]: [unit] }));
    if (getQuantityMode(med) === 'custom') {
      setCustomOrderQuantities((prev) => ({
        ...prev,
        [med.id]: Math.max(1, Math.ceil(currentPills / nextUnitSize)),
      }));
    }
  };

  const handleCustomQuantityChange = (med: Medication, quantity: number) => {
    setCustomOrderQuantities((prev) => ({
      ...prev,
      [med.id]: Math.max(1, quantity || 1),
    }));
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

  const activeOrderItems = useMemo((): OrderItem[] => {
    return displayList
      .filter((med) => selectedMedIds.has(med.id))
      .map((med) => {
        const { quantity: suggestedPills } = getRequestedAmount(med);
        return {
          name: med.name,
          quantity: getRequestedPills(med, suggestedPills),
          unit: med.unit,
          stripsPerBox: med.stripsPerBox,
          pillsPerStrip: med.pillsPerStrip,
          packageSize: med.packageSize,
        };
      });
  }, [displayList, selectedMedIds, settings.customQuantities, medicationPeriods, quantityModes, customOrderQuantities, orderUnits]);

  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const orderItemsForMessage = useMemo((): OrderItem[] => {
    if (activeOrderItems.length > 0) return activeOrderItems;
    return medications.map((med) => {
      const { quantity: suggestedPills } = getRequestedAmount(med);
      return {
        name: med.name,
        quantity: getRequestedPills(med, suggestedPills),
        unit: med.unit,
        stripsPerBox: med.stripsPerBox,
        pillsPerStrip: med.pillsPerStrip,
        packageSize: med.packageSize,
      };
    });
  }, [activeOrderItems, medications, medicationPeriods, quantityModes, customOrderQuantities, orderUnits]);

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

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between text-xs px-1">
        <span className="font-bold text-slate-700">
          الأدوية المتاحة للطلب ({selectedCount} من {displayList.length})
        </span>
        <div className="flex items-center gap-2 text-[11px]">
          <div className="flex items-center gap-1 rounded-2xl bg-teal-600 p-1 shadow-xs" role="group" aria-label="نطاق الأدوية">
            <button
              type="button"
              onClick={() => setShowAllForPlanning(false)}
              className={`rounded-xl px-2.5 py-1.5 font-bold transition ${!showAllForPlanning ? 'bg-white text-teal-700 shadow-xs' : 'text-white hover:bg-teal-700'}`}
            >
              النواقص فقط
            </button>
            <button
              type="button"
              onClick={() => setShowAllForPlanning(true)}
              className={`rounded-xl px-2.5 py-1.5 font-bold transition ${showAllForPlanning ? 'bg-white text-teal-700 shadow-xs' : 'text-white hover:bg-teal-700'}`}
            >
              كل الأدوية
            </button>
          </div>
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
          const { quantity: suggestedPills } = getRequestedAmount(med);
          const requestedPills = getRequestedPills(med, suggestedPills);
          const depletion = getDepletionDate(med);
          const isSelected = selectedMedIds.has(med.id);
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
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => handleToggleQuantityMode(med, 'period', suggestedPills)}
                    className={`rounded-lg px-2 py-1.5 text-[10px] font-bold ${getQuantityMode(med) === 'period' ? 'bg-teal-700 text-white' : 'text-slate-600'}`}
                  >
                    حسب الفترة
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleQuantityMode(med, 'custom', suggestedPills)}
                    className={`rounded-lg px-2 py-1.5 text-[10px] font-bold ${getQuantityMode(med) === 'custom' ? 'bg-teal-700 text-white' : 'text-slate-600'}`}
                  >
                    كمية محددة
                  </button>
                </div>

                {getQuantityMode(med) === 'period' && (
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-teal-100 bg-teal-50/60 px-3 py-2">
                    <span className="text-[11px] font-bold text-teal-900">مدة الطلب</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="1"
                        value={getMedicationPeriod(med).value}
                        onChange={(event) => handleMedicationPeriodChange(med.id, 'value', event.target.value)}
                        className="w-14 rounded-lg border border-teal-200 bg-white px-2 py-1 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                        aria-label={`عدد مدة طلب ${med.name}`}
                      />
                      <select
                        value={getMedicationPeriod(med).unit}
                        onChange={(event) => handleMedicationPeriodChange(med.id, 'unit', event.target.value)}
                        className="rounded-lg border border-teal-200 bg-white px-2 py-1 font-bold text-xs text-teal-900 outline-none"
                        aria-label={`وحدة مدة طلب ${med.name}`}
                      >
                        <option value="day">يوم</option>
                        <option value="month">شهر</option>
                      </select>
                    </div>
                  </div>
                )}
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
                    return (
                      <div key={unit} className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-slate-500 font-bold">{unitLabel(unit, med, unitQty)}</span>
                        {getQuantityMode(med) === 'custom' ? (
                          <input
                            type="number"
                            min="1"
                            value={unitQty}
                            onChange={(event) => handleCustomQuantityChange(med, parseInt(event.target.value, 10) || 1)}
                            className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-center font-mono font-bold text-sm focus:ring-1 focus:ring-teal-500"
                            aria-label={`كمية ${med.name}`}
                          />
                        ) : (
                          <span className="text-xs font-mono font-bold text-teal-800">{unitQty}</span>
                        )}
                      </div>
                    );
                  })}
                  <div className="text-[11px] text-teal-800 text-left">
                    الإجمالي: {describeOrderInBoxes(requestedPills, med.stripsPerBox, med.pillsPerStrip, med.packageSize, med.unit)}
                  </div>
                </div>

              </div>

            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={handleSendToWhatsApp}
        aria-label="إرسال طلبية بالواتساب"
        className="fixed bottom-[128px] left-4 z-40 flex items-center gap-2 rounded-2xl border border-teal-400/40 bg-teal-600 px-4 py-3 text-xs font-bold text-white shadow-xl ring-2 ring-white/60 transition-all duration-200 hover:bg-teal-700 active:scale-95 sm:text-sm"
      >
        <MessageCircle className="w-5 h-5" />
        <span>إرسال طلبية بالواتساب</span>
      </button>

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

          </div>
        </div>
      )}
    </div>
  );
};
