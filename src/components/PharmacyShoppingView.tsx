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
} from 'lucide-react';
import type { Medication, PharmacySettings } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import { describeOrderInBoxes } from '../utils/medicationPackaging';
import { pluralizeArabic } from '../lib/arabicPlural';
import { getDepletionDate } from '../utils/dateCalculations';
import { formatDepletionDate } from '../utils/medicationPresentation';
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
import { PharmacyShoppingSendModal } from './PharmacyShoppingSendModal';
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
  onRegisterBackHandler?: (id: string, close: () => void, priority?: number) => () => void;
}
export const PharmacyShoppingView: FC<PharmacyShoppingViewProps> = ({
  medications,
  settings,
  onUpdateSettings,
  showToast,
  onOpenUserContactsSettings = () => {},
  onRegisterBackHandler,
}) => {
  type PeriodUnit = 'day' | 'month';
  type MedicationPeriod = { value: number | ''; unit: PeriodUnit };
  type QuantityMode = 'period' | 'custom';
  const [medicationPeriods, setMedicationPeriods] = useState<Record<string, MedicationPeriod>>({});
  const [quantityModes, setQuantityModes] = useState<Record<string, QuantityMode>>({});
  const [customOrderQuantities, setCustomOrderQuantities] = useState<CustomOrderQuantities>({});
  useEffect(() => {
    if (!isSendModalOpen || !onRegisterBackHandler) return;
    return onRegisterBackHandler('shopping-send-order', () => setIsSendModalOpen(false), 100);
  }, [isSendModalOpen, onRegisterBackHandler]);
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
    // rendering / StrictMode because updaters must be pure.
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
                      المتبقي: <strong className="font-mono text-slate-700">{med.currentPills}</strong> • ينفد {formatDepletionDate(depletion.dateStr, depletion.daysLeft, Number(med.currentPills) || 0)}
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
                {/* Toolbar: keep the quantity-mode switch on the right and
                    the unit controls in a fixed left column. In custom mode,
                    each quantity input is rendered directly under its unit toggle. */}
                <div className="flex items-start justify-between gap-1.5">
                  <div className="shrink-0">
                    <SegmentedButton<'period' | 'custom'>
                      className="w-[180px] shrink-0"
                      size="sm"
                      value={getQuantityMode(med)}
                      onChange={(val) => handleToggleQuantityMode(med, val, suggestedPills)}
                      options={[
                        { value: 'period', label: 'حسب الفترة' },
                        { value: 'custom', label: 'كمية محددة' },
                      ]}
                      aria-label={`طريقة حساب كمية طلب ${med.name}`}
                    />
                  </div>
                  {availableUnits.length > 1 ? (
                    <div className="flex items-start gap-1 shrink-0">
                      {availableUnits.map((u) => {
                        const isActive = selectedUnits.includes(u);
                        const icon =
                          u === 'pills' ? (
                            <Pill className="w-2.5 h-2.5" />
                          ) : u === 'boxes' ? (
                            <Box className="w-2.5 h-2.5" />
                          ) : (
                            <Layers className="w-2.5 h-2.5" />
                          );
                        const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
                        const label = u === 'pills' ? med.unit : u === 'boxes' ? boxLabel : 'شريط';
                        const inputValue = getCustomQuantityInputValue(med, u, suggestedPills);
                        return (
                          <div
                            key={u}
                            className="flex flex-col items-stretch gap-1 w-[3.75rem] shrink-0"
                          >
                            <button
                              type="button"
                              onClick={() => handleToggleOrderUnit(med, u, suggestedPills)}
                              aria-pressed={isActive}
                              className={`w-full h-[28px] px-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1 transition cursor-pointer border select-none ${
                                isActive
                                  ? 'bg-teal-100 text-teal-950 border-teal-300 shadow-2xs'
                                  : 'bg-slate-50/80 text-slate-600 border-slate-200/90 hover:bg-slate-100'
                              }`}
                            >
                              {icon}
                              <span className="whitespace-nowrap">{label}</span>
                            </button>
                            {getQuantityMode(med) === 'custom' && isActive && (
                              <input
                                type="number"
                                min="1"
                                value={inputValue}
                                onChange={(event) =>
                                  handleCustomQuantityChange(med, u, event.target.value)
                                }
                                className="w-full min-w-0 box-border rounded-md border border-slate-300 bg-white px-1 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                                aria-label={`كمية ${med.name} ${label}`}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    getQuantityMode(med) === 'custom' &&
                    selectedUnits.map((unit) => {
                      const inputValue = getCustomQuantityInputValue(
                        med,
                        unit,
                        suggestedPills
                      );
                      const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
                      const label =
                        unit === 'pills'
                          ? med.unit
                          : unit === 'boxes'
                          ? boxLabel
                          : 'شريط';
                      return (
                        <input
                          key={unit}
                          type="number"
                          min="1"
                          value={inputValue}
                          onChange={(event) =>
                            handleCustomQuantityChange(med, unit, event.target.value)
                          }
                          className="w-[3.75rem] shrink-0 box-border rounded-md border border-slate-300 bg-white px-1 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                          aria-label={`كمية ${med.name} ${label}`}
                        />
                      );
                    })
                  )}
                </div>
                {/* Period duration row (custom quantities already sit under toggles) */}
                {getQuantityMode(med) === 'period' && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-teal-100/90 bg-teal-50/40 px-2.5 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold text-teal-900">مدة الطلب</span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="1"
                          value={getMedicationPeriod(med).value}
                          onChange={(event) =>
                            handleMedicationPeriodChange(med.id, 'value', event.target.value)
                          }
                          className="w-12 rounded-md border border-teal-200 bg-white px-1 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                          aria-label={`عدد مدة طلب ${med.name}`}
                        />
                        <select
                          value={getMedicationPeriod(med).unit}
                          onChange={(event) =>
                            handleMedicationPeriodChange(med.id, 'unit', event.target.value)
                          }
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
                        <span
                          key={unit}
                          className="text-[11px] text-teal-900 font-bold bg-white/90 border border-teal-200/80 rounded-md px-2 py-0.5 shadow-2xs"
                        >
                          {unitLabel(unit, med, unitQty)}
                        </span>
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
      <PharmacyShoppingSendModal
        isOpen={isSendModalOpen}
        settings={settings}
        onUpdateSettings={onUpdateSettings}
        pharmacies={pharmacies}
        selectedPharmacy={selectedPharmacy}
        whatsappContacts={whatsappContacts}
        whatsappAddresses={whatsappAddresses}
        selectedWhatsappContactIds={selectedWhatsappContactIds}
        selectedWhatsappAddressIds={selectedWhatsappAddressIds}
        toggleWhatsappContact={toggleWhatsappContact}
        toggleWhatsappAddress={toggleWhatsappAddress}
        selectedCount={selectedCount}
        hasPharmacyPhone={hasPharmacyPhone}
        displayPhone={displayPhone}
        targetWaUrl={targetWaUrl}
        currentWhatsAppMessage={currentWhatsAppMessage}
        activeOrderItems={activeOrderItems}
        onOpenUserContactsSettings={onOpenUserContactsSettings}
        showToast={showToast}
        onClose={() => setIsSendModalOpen(false)}
      />
    </div>
  );
};