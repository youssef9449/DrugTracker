import type { FC } from 'react';
import { CheckSquare, Square, Layers, Box, Pill, X } from 'lucide-react';
import type { Medication } from '../types';
import { formatDepletionDate } from '../utils/medicationPresentation';
import { getDepletionDate } from '../utils/dateCalculations';
import { describeOrderInBoxes, getMedSizes } from '../utils/medicationPackaging';
import { pluralizeArabic } from '../lib/arabicPlural';
import { SegmentedButton } from './ui/SegmentedButton';

type OrderUnit = 'pills' | 'boxes' | 'strips';
type QuantityMode = 'period' | 'custom';
type MedicationPeriod = { value: number | ''; unit: 'day' | 'month' };

interface Props {
  medication: Medication;
  status: ReturnType<typeof import('../utils/medicationStatus').calculateMedicationStatus>['status'];
  suggestedPills: number;
  requestedPills: number;
  isSelected: boolean;
  availableUnits: OrderUnit[];
  selectedUnits: OrderUnit[];
  getQuantityMode: (med: Medication) => QuantityMode;
  getCustomQuantityInputValue: (med: Medication, unit: OrderUnit, suggestedPills: number) => number | '';
  getMedicationPeriod: (med: Medication) => MedicationPeriod;
  getUnitQuantity: (med: Medication, unit: OrderUnit, suggestedPills: number) => number;
  getOrderBreakdown: (med: Medication, suggestedPills: number) => Array<{ unit: OrderUnit; quantity: number }>;
  unitLabel: (unit: OrderUnit, med: Medication, count: number) => string;
  describeOrderQuantityBreakdown: (items: Array<{ unit: OrderUnit; quantity: number }>, unit: string) => string;
  onToggleSelect: (id: string) => void;
  onRemoveFromShopping: (id: string) => void;
  onToggleQuantityMode: (med: Medication, mode: QuantityMode, suggestedPills: number) => void;
  onToggleOrderUnit: (med: Medication, unit: OrderUnit, suggestedPills: number) => void;
  onCustomQuantityChange: (med: Medication, unit: OrderUnit, raw: string) => void;
  onMedicationPeriodChange: (medId: string, field: keyof MedicationPeriod, value: string) => void;
}

export const PharmacyShoppingMedicationRow: FC<Props> = ({
  medication: med, status, suggestedPills, requestedPills, isSelected, availableUnits, selectedUnits,
  getQuantityMode, getCustomQuantityInputValue, getMedicationPeriod, getUnitQuantity, getOrderBreakdown,
  unitLabel, describeOrderQuantityBreakdown, onToggleSelect, onRemoveFromShopping, onToggleQuantityMode,
  onToggleOrderUnit, onCustomQuantityChange, onMedicationPeriodChange,
}) => {
  const depletion = getDepletionDate(med);
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
};
