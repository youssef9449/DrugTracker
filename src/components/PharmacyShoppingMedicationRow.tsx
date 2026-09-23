import type { FC } from 'react';
import { CheckSquare, Square, Layers, Box, Pill, X } from 'lucide-react';
import type { Medication } from '../types';
import { getDepletionDate } from '../utils/dateCalculations';
import { formatDepletionDate } from '../utils/medicationPresentation';
import { describeOrderInBoxes } from '../utils/medicationPackaging';
import { pluralizeArabic } from '../lib/arabicPlural';
import { SegmentedButton } from './ui/SegmentedButton';

type OrderUnit = 'pills' | 'boxes' | 'strips';
type QuantityMode = 'period' | 'custom';
type MedicationPeriod = { value: number | ''; unit: 'day' | 'month' };

interface Props {
  medication: Medication;
  status: 'out_of_stock' | 'critical' | 'warning' | 'sufficient';
  suggestedPills: number;
  requestedPills: number;
  isSelected: boolean;
  availableUnits: OrderUnit[];
  selectedUnits: OrderUnit[];
  getQuantityMode: (med: Medication) => QuantityMode;
  getCustomQuantityInputValue: (med: Medication, unit: OrderUnit, suggestedPills: number) => number | '';
  getMedicationPeriod: (med: Medication) => MedicationPeriod;
  getUnitQuantity: (med: Medication, unit: OrderUnit, suggestedPills: number) => number;
  getOrderBreakdown: (med: Medication, suggestedPills: number) => any[];
  unitLabel: (unit: OrderUnit, med: Medication, count: number) => string;
  describeOrderQuantityBreakdown: (items: any[], unit: string) => string;
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
              )
  );
};
