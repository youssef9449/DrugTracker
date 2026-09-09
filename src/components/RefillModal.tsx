import { useState, useEffect, type FC, type FormEvent } from 'react';
import { X, PlusCircle, Check, Layers, Box, Pill } from 'lucide-react';
import { Medication, describeStockInStrips } from '../types';
import { pluralizeArabic } from '../lib/arabicPlural';

interface RefillModalProps {
  medication: Medication | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmRefill: (medicationId: string, addedPills: number) => void;
}

type RefillUnit = 'pills' | 'boxes' | 'strips';

export const RefillModal: FC<RefillModalProps> = ({
  medication,
  isOpen,
  onClose,
  onConfirmRefill,
}) => {
  // Total pill count — what gets passed to onConfirmRefill.
  const [addedCount, setAddedCount] = useState<number>(30);
  // Per-unit quantity — what the user types in the selected unit.
  const [unitQty, setUnitQty] = useState<number>(1);
  const [refillUnit, setRefillUnit] = useState<RefillUnit>('pills');

  // Sync defaults when modal opens.
  useEffect(() => {
    if (medication && isOpen) {
      const sz = getMedSizes(medication);
      // Default to 1 box.
      setAddedCount(sz.boxSize);
      setUnitQty(1);
      setRefillUnit('boxes');
    }
  }, [medication, isOpen]);

  if (!isOpen || !medication) return null;

  const sz = getMedSizes(medication);
  const isSolid = sz.isSolid;
  const availableUnits = getAvailableUnits(medication, sz);
  const boxLabel = medication.unit === 'مل' ? 'عبوة' : 'علبة';

  // Convert unit qty → pills.
  function unitToPills(qty: number, unit: RefillUnit): number {
    if (unit === 'boxes') return qty * sz.boxSize;
    if (unit === 'strips') return qty * sz.stripSize;
    return qty;
  }

  // When the user changes the unit, recompute the pill count from the
  // current unitQty in the new unit.
  function handleUnitChange(newUnit: RefillUnit) {
    setRefillUnit(newUnit);
    const pills = unitToPills(unitQty, newUnit);
    setAddedCount(Math.max(1, pills));
  }

  // When the user types a quantity in the current unit, recompute pills.
  function handleQtyChange(newQty: number) {
    const safeQty = Math.max(1, newQty);
    setUnitQty(safeQty);
    setAddedCount(unitToPills(safeQty, refillUnit));
  }

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    if (addedCount <= 0) return;
    onConfirmRefill(medication.id, addedCount);
    onClose();
  };

  const newTotal = medication.currentPills + addedCount;
  const newDays =
    medication.dailyDose > 0 ? Math.floor(newTotal / medication.dailyDose) : 0;

  const currentStripsDesc = isSolid
    ? describeStockInStrips(
        medication.currentPills,
        medication.pillsPerStrip,
        medication.stripsPerBox,
        medication.unit
      )
    : null;

  const newStripsDesc = isSolid
    ? describeStockInStrips(
        newTotal,
        medication.pillsPerStrip,
        medication.stripsPerBox,
        medication.unit
      )
    : null;

  const unitStep = refillUnit === 'pills' ? sz.boxSize : 1;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs">
      <div
        className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom duration-200"
        dir="rtl"
      >
        <div className="px-5 py-4 bg-teal-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PlusCircle className="w-5 h-5 text-teal-200" />
            <h3 className="font-bold text-base">إعادة تعبئة المخزون</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-teal-200 hover:text-white hover:bg-teal-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 space-y-4">
          <div>
            <span className="text-xs text-slate-500 block">الدواء المحدد:</span>
            <h4 className="font-bold text-base text-slate-800 mt-0.5">{medication.name}</h4>
            <div className="mt-1 text-xs text-slate-600 flex items-center gap-1.5 flex-wrap">
              <span>المتوفر حالياً:</span>
              <strong className="font-mono text-teal-700">{medication.currentPills} {medication.unit}</strong>
              {currentStripsDesc && (
                <span className="text-[11px] text-slate-500 font-medium">({currentStripsDesc})</span>
              )}
            </div>
            {sz.hasStrips && (
              <div className="mt-1 text-[11px] text-teal-800 bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200/60 inline-flex items-center gap-1">
                <Layers className="w-3 h-3 text-teal-600" />
                <span>مواصفات العلبة: {medication.stripsPerBox} أشرطة × {medication.pillsPerStrip} {medication.unit}</span>
              </div>
            )}
            {!isSolid && medication.packageSize && medication.packageSize > 0 && (
              <div className="mt-1 text-[11px] text-teal-800 bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200/60 inline-flex items-center gap-1">
                <Box className="w-3 h-3 text-teal-600" />
                <span>سعة العبوة: {medication.packageSize} {medication.unit}</span>
              </div>
            )}
          </div>

          {/* Unit selector chips */}
          {availableUnits.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {availableUnits.map((u) => {
                const isActive = refillUnit === u;
                const icon = u === 'pills' ? <Pill className="w-3 h-3" /> : u === 'boxes' ? <Box className="w-3 h-3" /> : <Layers className="w-3 h-3" />;
                const label = u === 'pills' ? medication.unit : u === 'boxes' ? boxLabel : 'شريط';
                return (
                  <button
                    key={u}
                    type="button"
                    onClick={() => handleUnitChange(u)}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 transition ${
                      isActive
                        ? 'bg-teal-700 text-white shadow-xs'
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

          {/* Quantity input with +/- in the selected unit */}
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => handleQtyChange(unitQty - unitStep)}
              className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-200 font-bold text-sm"
            >
              -
            </button>
            <div className="text-center min-w-[80px]">
              <input
                type="number"
                min="1"
                value={unitQty}
                onChange={(e) => handleQtyChange(parseInt(e.target.value) || 1)}
                className="w-20 px-2 py-1.5 text-center font-mono font-bold text-base border border-slate-300 rounded-xl focus:ring-2 focus:ring-teal-500"
              />
              <div className="text-[10px] text-slate-400 mt-0.5">
                {refillUnit === 'pills' ? pluralizeArabic(unitQty, medication.unit) : refillUnit === 'boxes' ? pluralizeArabic(unitQty, boxLabel) : pluralizeArabic(unitQty, 'شريط')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleQtyChange(unitQty + unitStep)}
              className="w-8 h-8 rounded-lg bg-slate-50 border border-slate-200 font-bold text-sm"
            >
              +
            </button>
          </div>

          {/* New estimation preview */}
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs space-y-1">
            <div className="flex justify-between items-center text-emerald-950 font-medium">
              <span>المجموع بعد الإضافة:</span>
              <div className="text-left">
                <span className="font-bold font-mono">{newTotal} {medication.unit}</span>
                {newStripsDesc && (
                  <span className="block text-[10px] text-emerald-800 font-medium">({newStripsDesc})</span>
                )}
              </div>
            </div>
            <div className="flex justify-between text-emerald-800 pt-0.5">
              <span>سيكفيك لمدة:</span>
              <span className="font-bold font-mono">{newDays} يوماً</span>
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 active:scale-98 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition"
          >
            <Check className="w-4 h-4" />
            <span>تأكيد إضافة المخزون (+{addedCount} {medication.unit})</span>
          </button>
        </form>
      </div>
    </div>
  );
};

// ── Helpers (same pattern as PharmacyShoppingView) ─────────────

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

function getAvailableUnits(med: Medication, sz: ReturnType<typeof getMedSizes>): RefillUnit[] {
  const units: RefillUnit[] = ['pills'];
  if (sz.boxSize > 0) units.push('boxes');
  if (sz.hasStrips && sz.stripSize > 0) units.push('strips');
  return units;
}
