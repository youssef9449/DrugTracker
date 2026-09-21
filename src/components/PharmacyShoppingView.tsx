import { useState, useMemo, useEffect, type FC } from 'react';
import {
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
import { Medication, PharmacySettings, calculateMedicationStatus, describeOrderInBoxes, isSolidUnit } from '../types';
import { pluralizeArabic } from '../lib/arabicPlural';
import { getDepletionDate } from '../utils/dateCalculations';
import {
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  describeOrderQuantityBreakdown,
  OrderItem,
  calculateMedicationOrderQuantity,
  buildWhatsAppUrl,
} from '../utils/whatsapp';
import { getMedSizes } from '../utils/medicationPackaging';
import { Checkbox } from './ui/Checkbox';
import { SegmentedButton } from './ui/SegmentedButton';


function shoppingDurationDays(
  med: Medication,
  medicationPeriods: Record<string, { value: number | ''; unit: 'day' | 'month' }>,
  defaultDurationDays: number
): number {
  const period = medicationPeriods[med.id] || {
    value: defaultDurationDays === 60 ? 2 : 30,
    unit: (defaultDurationDays === 60 ? 'month' : 'day') as 'day' | 'month',
  };
  const rawValue = period.value === '' ? 1 : period.value;
  return Math.max(1, rawValue || 1) * (period.unit === 'month' ? 30 : 1);
}

type OrderUnit = 'pills' | 'boxes' | 'strips';
type CustomOrderQuantities = Record<string, Partial<Record<OrderUnit, number | ''>>>;

function getShoppingAvailableUnits(med: Medication): OrderUnit[] {
  const { boxSize, stripSize, hasStrips } = getMedSizes(med);

  // Solid medications with configured strips can be ordered as strips and/or boxes.
  if (hasStrips && stripSize > 0) {
    return boxSize > 0 ? ['strips', 'boxes'] : ['strips'];
  }

  // Sachets/doses may be ordered as loose units and/or full boxes.
  if ((med.unit === 'كيس' || med.unit === 'جرعة') && boxSize > 0) {
    return ['pills', 'boxes'];
  }

  return ['boxes'];
}

function getShoppingDefaultUnits(med: Medication): OrderUnit[] {
  return [getShoppingAvailableUnits(med)[0]];
}

function getShoppingUnitSize(med: Medication, unit: OrderUnit): number {
  const { boxSize, stripSize } = getMedSizes(med);
  if (unit === 'boxes') return boxSize > 0 ? boxSize : 1;
  if (unit === 'strips') return stripSize > 0 ? stripSize : 1;
  return 1;
}

function shoppingUnitToPills(med: Medication, unit: OrderUnit, quantity: number): number {
  return quantity * getShoppingUnitSize(med, unit);
}

function shoppingRequestedPills(
  med: Medication,
  suggestedPills: number,
  quantityModes: Record<string, 'period' | 'custom'>,
  customOrderQuantities: CustomOrderQuantities,
  orderUnits: Record<string, OrderUnit[]>
): number {
  const mode = quantityModes[med.id] || 'period';
  if (mode !== 'custom') return suggestedPills;

  const selectedUnits = orderUnits[med.id] || getShoppingDefaultUnits(med);
  return selectedUnits.reduce((total, unit) => {
    const stored = customOrderQuantities[med.id]?.[unit];
    const unitQty = stored === ''
      ? 0
      : stored ?? Math.max(1, Math.ceil(
          suggestedPills / getShoppingUnitSize(med, unit)
        ));
    return total + shoppingUnitToPills(med, unit, unitQty);
  }, 0);
}

interface PharmacyShoppingViewProps {
  medications: Medication[];
  settings: PharmacySettings;
  onUpdateSettings: (newSettings: PharmacySettings) => void;
  showToast: (message: string) => void;
  onOpenUserContactsSettings?: () => void;
}

export const PharmacyShoppingView: FC<PharmacyShoppingViewProps> = ({
  medications,
  settings,
  onUpdateSettings,
  showToast,
  onOpenUserContactsSettings = () => {},
}) => {
  type PeriodUnit = 'day' | 'month';
  type MedicationPeriod = { value: number | ''; unit: PeriodUnit };
  type QuantityMode = 'period' | 'custom';
  const [medicationPeriods, setMedicationPeriods] = useState<Record<string, MedicationPeriod>>({});
  const [quantityModes, setQuantityModes] = useState<Record<string, QuantityMode>>({});
  const [customOrderQuantities, setCustomOrderQuantities] = useState<CustomOrderQuantities>({});
  const pharmacies = settings.pharmacies || [];
  const selectedPharmacy = pharmacies.find((pharmacy) => pharmacy.id === settings.selectedPharmacyId)
    || pharmacies[0];
  const whatsappContacts = useMemo(
    () => settings.whatsappContacts ?? [],
    [settings.whatsappContacts]
  );
  const whatsappAddresses = useMemo(
    () => settings.whatsappAddresses ?? [],
    [settings.whatsappAddresses]
  );
  const selectedWhatsappContactIds = settings.selectedWhatsappContactIds
    ?? whatsappContacts.map((contact) => contact.id);
  const selectedWhatsappAddressIds = settings.selectedWhatsappAddressIds
    ?? whatsappAddresses.map((item) => item.id);

  const [showAllForPlanning, setShowAllForPlanning] = useState(false);
  // Multiple order units may be selected together in "كمية محددة".
  const [orderUnits, setOrderUnits] = useState<Record<string, OrderUnit[]>>({});
  const [removedFromShoppingIds, setRemovedFromShoppingIds] = useState<Set<string>>(new Set());
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
  const displayList = (effectiveShowAll ? medications : urgentMeds)
    .filter((medication) => !removedFromShoppingIds.has(medication.id));

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

  const handleRemoveFromShopping = (id: string) => {
    setRemovedFromShoppingIds((prev) => new Set(prev).add(id));
    setSelectedMedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setDeselectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const getMedicationPeriod = (med: Medication): MedicationPeriod => medicationPeriods[med.id] || {
    value: settings.defaultDurationDays === 60 ? 2 : 30,
    unit: settings.defaultDurationDays === 60 ? 'month' : 'day',
  };

  const getDurationDays = (med: Medication) => {
    const period = getMedicationPeriod(med);
    const rawValue = period.value === '' ? 1 : period.value;
    return Math.max(1, rawValue || 1) * (period.unit === 'month' ? 30 : 1);
  };

  const getQuantityMode = (med: Medication): QuantityMode => quantityModes[med.id] || 'period';

  const handleMedicationPeriodChange = (medId: string, field: keyof MedicationPeriod, value: string) => {
    const med = medications.find((item) => item.id === medId);
    if (!med) return;

    const currentPeriod = getMedicationPeriod(med);

    if (field === 'unit') {
      const nextUnit = value as PeriodUnit;
      const currentValue = currentPeriod.value === '' ? 1 : currentPeriod.value;
      const currentDays = currentValue * (currentPeriod.unit === 'month' ? 30 : 1);
      const nextValue = nextUnit === 'month'
        ? Math.max(1, Math.ceil(currentDays / 30))
        : Math.max(1, currentDays);

      setMedicationPeriods((prev) => ({
        ...prev,
        [medId]: {
          value: nextValue,
          unit: nextUnit,
        },
      }));
      return;
    }

    const nextValue = value === '' ? '' : Math.max(1, parseInt(value, 10) || 1);
    setMedicationPeriods((prev) => ({
      ...prev,
      [medId]: {
        ...currentPeriod,
        value: nextValue,
      },
    }));
  };

  const getRequestedAmount = (med: Medication) =>
    calculateMedicationOrderQuantity(med, getDurationDays(med));

  // ── Unit display helpers ─────────────────────────────────────
  // The selected unit only changes how the calculated quantity is shown.
  // It must never change the quantity required for the selected period.

  /** Available order units; custom mode can select more than one simultaneously. */
  function getAvailableUnits(med: Medication): OrderUnit[] {
    return getShoppingAvailableUnits(med);
  }

  function getSelectedUnits(med: Medication): OrderUnit[] {
    return orderUnits[med.id] || getShoppingDefaultUnits(med);
  }

  function getUnitQuantity(med: Medication, unit: OrderUnit, suggestedPills: number): number {
    if (getQuantityMode(med) === 'custom') {
      const stored = customOrderQuantities[med.id]?.[unit];
      if (stored === '') return 0;
      if (stored !== undefined) return stored;
    }

    const unitSize = getShoppingUnitSize(med, unit);
    return Math.max(1, Math.ceil(suggestedPills / unitSize));
  }

  /** Display value for each custom-unit input. */
  function getCustomQuantityInputValue(
    med: Medication,
    unit: OrderUnit,
    suggestedPills: number
  ): number | '' {
    const stored = customOrderQuantities[med.id]?.[unit];
    if (stored !== undefined) return stored;
    return getUnitQuantity(med, unit, suggestedPills);
  }

  function getRequestedPills(med: Medication, suggestedPills: number): number {
    return shoppingRequestedPills(
      med,
      suggestedPills,
      quantityModes,
      customOrderQuantities,
      orderUnits
    );
  }

  const handleToggleQuantityMode = (med: Medication, mode: QuantityMode, suggestedPills: number) => {
    setQuantityModes((prev) => ({ ...prev, [med.id]: mode }));

    if (mode !== 'custom') return;

    const selectedUnits = getSelectedUnits(med);
    setCustomOrderQuantities((prev) => {
      const current = prev[med.id] || {};
      const next = { ...current };
      for (const unit of selectedUnits) {
        if (next[unit] === undefined) {
          next[unit] = Math.max(1, Math.ceil(
            suggestedPills / getShoppingUnitSize(med, unit)
          ));
        }
      }
      return {
        ...prev,
        [med.id]: next,
      };
    });
  };

  const handleToggleOrderUnit = (med: Medication, unit: OrderUnit, suggestedPills: number) => {
    const selected = getSelectedUnits(med);

    if (getQuantityMode(med) !== 'custom') {
      // "حسب الفترة" keeps the existing single-unit display selection.
      setOrderUnits((prev) => ({
        ...prev,
        [med.id]: [unit],
      }));
      return;
    }

    if (selected.includes(unit)) {
      // Keep at least one unit active in custom mode.
      if (selected.length <= 1) return;
      setOrderUnits((prev) => ({
        ...prev,
        [med.id]: selected.filter((item) => item !== unit),
      }));
      return;
    }

    setOrderUnits((prev) => ({
      ...prev,
      [med.id]: [...selected, unit],
    }));

    setCustomOrderQuantities((prev) => ({
      ...prev,
      [med.id]: {
        ...(prev[med.id] || {}),
        [unit]: 1,
      },
    }));
  };

  const handleCustomQuantityChange = (med: Medication, unit: OrderUnit, raw: string) => {
    if (raw === '') {
      setCustomOrderQuantities((prev) => ({
        ...prev,
        [med.id]: {
          ...(prev[med.id] || {}),
          [unit]: '',
        },
      }));
      return;
    }

    const parsed = parseInt(raw, 10);
    setCustomOrderQuantities((prev) => ({
      ...prev,
      [med.id]: {
        ...(prev[med.id] || {}),
        [unit]: Math.max(1, Number.isFinite(parsed) ? parsed : 1),
      },
    }));
  };

  /** Display label for a unit. */
  function unitLabel(unit: OrderUnit, med: Medication, count: number): string {
    if (unit === 'pills') return pluralizeArabic(count, med.unit);
    if (unit === 'boxes') {
      const boxName = med.unit === 'مل' ? 'عبوة' : 'علبة';
      return pluralizeArabic(count, boxName);
    }
    return pluralizeArabic(count, 'شريط');
  }

  function getOrderBreakdown(med: Medication, suggestedPills: number) {
    if (getQuantityMode(med) !== 'custom') return undefined;
    return getSelectedUnits(med)
      .map((unit) => ({
        unit,
        quantity: getUnitQuantity(med, unit, suggestedPills),
      }))
      .filter((item) => item.quantity > 0);
  }

  const activeOrderItems = useMemo((): OrderItem[] => {
    return displayList
      .filter((med) => selectedMedIds.has(med.id))
      .map((med) => {
        const { quantity: suggestedPills } = calculateMedicationOrderQuantity(
          med,
          shoppingDurationDays(med, medicationPeriods, settings.defaultDurationDays)
        );
        return {
          name: med.name,
          quantity: shoppingRequestedPills(
            med,
            suggestedPills,
            quantityModes,
            customOrderQuantities,
            orderUnits
          ),
          unit: med.unit,
          stripsPerBox: med.stripsPerBox,
          pillsPerStrip: med.pillsPerStrip,
          packageSize: med.packageSize,
          orderBreakdown: getOrderBreakdown(med, suggestedPills),
        };
      });
  }, [displayList, selectedMedIds, medicationPeriods, quantityModes, customOrderQuantities, orderUnits, settings.defaultDurationDays]);

  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const orderItemsForMessage = useMemo((): OrderItem[] => {
    if (activeOrderItems.length > 0) return activeOrderItems;
    return medications.map((med) => {
      const { quantity: suggestedPills } = calculateMedicationOrderQuantity(
        med,
        shoppingDurationDays(med, medicationPeriods, settings.defaultDurationDays)
      );
      return {
        name: med.name,
        quantity: shoppingRequestedPills(
          med,
          suggestedPills,
          quantityModes,
          customOrderQuantities,
          orderUnits
        ),
        unit: med.unit,
        stripsPerBox: med.stripsPerBox,
        pillsPerStrip: med.pillsPerStrip,
        packageSize: med.packageSize,
        orderBreakdown: getOrderBreakdown(med, suggestedPills),
      };
    });
  }, [activeOrderItems, medications, medicationPeriods, quantityModes, customOrderQuantities, orderUnits, settings.defaultDurationDays]);

  const currentWhatsAppMessage = useMemo(() => {
    return generatePharmacyOrderMessage(
      orderItemsForMessage,
      selectedPharmacy?.customerCode || '',
      '',
      '',
      whatsappAddresses
        .filter((item) => selectedWhatsappAddressIds.includes(item.id))
        .map((item) => item.address),
      whatsappContacts
        .filter((contact) => selectedWhatsappContactIds.includes(contact.id))
        .map((contact) => contact.phone)
    );
  }, [orderItemsForMessage, selectedPharmacy?.customerCode, whatsappAddresses, whatsappContacts, selectedWhatsappAddressIds, selectedWhatsappContactIds]);

  const toggleWhatsappContact = (id: string) => {
    const nextIds = selectedWhatsappContactIds.includes(id)
      ? selectedWhatsappContactIds.filter((selectedId) => selectedId !== id)
      : [...selectedWhatsappContactIds, id];
    onUpdateSettings({
      ...settings,
      whatsappContacts,
      whatsappAddresses,
      selectedWhatsappContactIds: nextIds,
      selectedWhatsappAddressIds,
    });
  };

  const toggleWhatsappAddress = (id: string) => {
    const nextIds = selectedWhatsappAddressIds.includes(id)
      ? selectedWhatsappAddressIds.filter((selectedId) => selectedId !== id)
      : [...selectedWhatsappAddressIds, id];
    onUpdateSettings({
      ...settings,
      whatsappContacts,
      whatsappAddresses,
      selectedWhatsappContactIds,
      selectedWhatsappAddressIds: nextIds,
    });
  };

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
          <div className="flex items-center gap-0.5 rounded-xl bg-teal-600 p-0.5 shadow-xs" role="group" aria-label="نطاق الأدوية">
            <button
              type="button"
              onClick={() => setShowAllForPlanning(false)}
              className={`rounded-lg px-2 py-1 text-[10px] font-bold transition ${!showAllForPlanning ? 'bg-white text-teal-700 shadow-xs' : 'text-white hover:bg-teal-700'}`}
            >
              النواقص فقط
            </button>
            <button
              type="button"
              onClick={() => {
                setRemovedFromShoppingIds(new Set());
                setShowAllForPlanning(true);
              }}
              className={`rounded-lg px-2 py-1 text-[10px] font-bold transition ${showAllForPlanning ? 'bg-white text-teal-700 shadow-xs' : 'text-white hover:bg-teal-700'}`}
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

      <div className="space-y-2">
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
              className={`bg-white rounded-2xl border p-2.5 sm:p-3 shadow-xs transition-colors ${
                isSelected ? 'border-teal-300 ring-1 ring-teal-100' : 'border-slate-200/80 opacity-75'
              }`}
            >
              {/* Header: Select Checkbox, Name, Status Badge, Remaining/Depletion & Remove Button */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => handleToggleSelect(med.id)}
                    className="mt-0.5 text-teal-700 shrink-0 transition hover:scale-105 active:scale-95"
                  >
                    {isSelected ? <CheckSquare className="w-4.5 h-4.5 text-teal-700" /> : <Square className="w-4.5 h-4.5 text-slate-300" />}
                  </button>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h4 className="font-bold text-slate-900 text-xs sm:text-sm leading-tight">{med.name}</h4>
                      <span
                        className={`inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded border leading-none ${
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
                    <div className="text-[11px] text-slate-500 mt-0.5 leading-tight">
                      المتبقي: <strong className="font-mono text-slate-700">{med.currentPills}</strong> • ينفد {depletion.formattedArabic}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveFromShopping(med.id)}
                  aria-label={`إزالة ${med.name} من قائمة الشراء`}
                  title="إزالة من قائمة الشراء"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 active:scale-95"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Unit selector + quantity controls */}
              <div className="mt-2 pt-2 border-t border-slate-100 space-y-1.5">
                {/* Controls toolbar: Mode selector & Packaging unit filter chips */}
                <div className="flex items-center justify-between gap-1.5 flex-wrap">
                  <SegmentedButton<'period' | 'custom'>
                    className="shrink-0"
                    size="sm"
                    value={getQuantityMode(med)}
                    onChange={(val) => handleToggleQuantityMode(med, val, suggestedPills)}
                    options={[
                      { value: 'period', label: 'حسب الفترة' },
                      { value: 'custom', label: 'كمية محددة' },
                    ]}
                    aria-label={`طريقة حساب كمية طلب ${med.name}`}
                  />

                  {/* Unit chips in period mode only; custom mode places each
                      quantity input under its unit toggle instead. */}
                  {getQuantityMode(med) === 'period' && availableUnits.length > 1 && (
                    <div className="flex items-center gap-1 shrink-0">
                      {availableUnits.map((u) => {
                        const isActive = selectedUnits.includes(u);
                        const icon = u === 'pills' ? <Pill className="w-2.5 h-2.5" /> : u === 'boxes' ? <Box className="w-2.5 h-2.5" /> : <Layers className="w-2.5 h-2.5" />;
                        const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
                        const label = u === 'pills' ? med.unit : u === 'boxes' ? boxLabel : 'شريط';
                        return (
                          <button
                            key={u}
                            type="button"
                            onClick={() => handleToggleOrderUnit(med, u, suggestedPills)}
                            aria-pressed={isActive}
                            className={`h-[28px] px-2 rounded-lg text-[10px] font-bold flex items-center gap-1 transition cursor-pointer border ${
                              isActive
                                ? 'bg-teal-100 text-teal-950 border-teal-300 shadow-2xs'
                                : 'bg-slate-50/80 text-slate-600 border-slate-200/90 hover:bg-slate-100'
                            }`}
                          >
                            {icon}
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Duration or Custom Quantity configuration row */}
                {getQuantityMode(med) === 'period' ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-teal-100/90 bg-teal-50/40 px-2.5 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold text-teal-900">مدة الطلب</span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="1"
                          value={getMedicationPeriod(med).value}
                          onChange={(event) => handleMedicationPeriodChange(med.id, 'value', event.target.value)}
                          className="w-12 rounded-md border border-teal-200 bg-white px-1 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                          aria-label={`عدد مدة طلب ${med.name}`}
                        />
                        <select
                          value={getMedicationPeriod(med).unit}
                          onChange={(event) => handleMedicationPeriodChange(med.id, 'unit', event.target.value)}
                          className="rounded-md border border-teal-200 bg-white px-1.5 py-0.5 font-bold text-xs text-teal-900 outline-none cursor-pointer"
                          aria-label={`وحدة مدة طلب ${med.name}`}
                        >
                          <option value="day">يوم</option>
                          <option value="month">شهر</option>
                        </select>
                      </div>
                    </div>

                    {selectedUnits.map((unit) => {
                      const unitQty = getUnitQuantity(med, unit, suggestedPills);
                      return (
                        <span key={unit} className="text-[11px] text-teal-900 font-bold bg-white/90 border border-teal-200/80 rounded-md px-2 py-0.5 shadow-2xs">
                          {unitLabel(unit, med, unitQty)}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  /* Custom mode: quantity input sits under its unit toggle —
                     no second row of detached unit icons/labels. */
                  <div className="flex flex-wrap items-start gap-1.5">
                    {(availableUnits.length > 1 ? availableUnits : selectedUnits).map((unit) => {
                      const isActive = selectedUnits.includes(unit);
                      const inputValue = getCustomQuantityInputValue(med, unit, suggestedPills);
                      const icon =
                        unit === 'pills' ? (
                          <Pill className="w-2.5 h-2.5" />
                        ) : unit === 'boxes' ? (
                          <Box className="w-2.5 h-2.5" />
                        ) : (
                          <Layers className="w-2.5 h-2.5" />
                        );
                      const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
                      const label =
                        unit === 'pills' ? med.unit : unit === 'boxes' ? boxLabel : 'شريط';
                      return (
                        <div
                          key={unit}
                          className="flex flex-col items-center gap-1 min-w-[4.5rem]"
                        >
                          {availableUnits.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleToggleOrderUnit(med, unit, suggestedPills)}
                              aria-pressed={isActive}
                              className={`h-[28px] w-full px-2 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1 transition cursor-pointer border ${
                                isActive
                                  ? 'bg-teal-100 text-teal-950 border-teal-300 shadow-2xs'
                                  : 'bg-slate-50/80 text-slate-600 border-slate-200/90 hover:bg-slate-100'
                              }`}
                            >
                              {icon}
                              <span>{label}</span>
                            </button>
                          )}
                          {isActive && (
                            <input
                              type="number"
                              min="1"
                              value={inputValue}
                              onChange={(event) =>
                                handleCustomQuantityChange(med, unit, event.target.value)
                              }
                              className="w-full min-w-[3.5rem] rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                              aria-label={`كمية ${med.name} ${label}`}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Total order description */}
                <div className="text-[10.5px] text-teal-800 text-left font-medium px-0.5">
                  الإجمالي:{' '}
                  {getQuantityMode(med) === 'custom'
                    ? describeOrderQuantityBreakdown(getOrderBreakdown(med, suggestedPills) || [], med.unit)
                    : describeOrderInBoxes(requestedPills, med.stripsPerBox, med.pillsPerStrip, med.packageSize, med.unit)}
                  {getQuantityMode(med) === 'custom' && requestedPills > 0
                    ? ` (${pluralizeArabic(requestedPills, med.unit)})`
                    : ''}
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
        className="fixed bottom-[112px] left-4 z-40 flex items-center gap-2 rounded-2xl border border-teal-400/40 bg-teal-600 px-4 py-3 text-xs font-bold text-white shadow-xl ring-2 ring-white/60 transition-all duration-200 hover:bg-teal-700 active:scale-95 sm:text-sm md:absolute md:bottom-16 md:left-auto md:right-5 md:rounded-xl md:px-3 md:py-2 md:text-xs"
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
                    <option value={selectedPharmacy.id}>{selectedPharmacy.name}</option>
                  )}
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
    </div>
  );
};
