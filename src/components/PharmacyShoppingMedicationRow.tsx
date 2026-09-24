import type { FC } from 'react';
import { CheckSquare, Square, Layers, Box, Pill, X } from 'lucide-react';
import type { Medication, MedicationStatus } from '../types';
import type { OrderQuantitySelection } from '../utils/whatsapp';
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
  status: MedicationStatus;
  suggestedPills: number;
  requestedPills: number;
  isSelected: boolean;
  availableUnits: OrderUnit[];
  selectedUnits: OrderUnit[];
  getQuantityMode: (med: Medication) => QuantityMode;
  getCustomQuantityInputValue: (med: Medication, unit: OrderUnit, suggestedPills: number) => number | '';
  getMedicationPeriod: (med: Medication) => MedicationPeriod;
  getUnitQuantity: (med: Medication, unit: OrderUnit, suggestedPills: number) => number;
  getOrderBreakdown: (med: Medication, suggestedPills: number) => OrderQuantitySelection[];
  unitLabel: (unit: OrderUnit, med: Medication, count: number) => string;
  describeOrderQuantityBreakdown: (items: OrderQuantitySelection[], unit: string) => string;
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
    <div className={`bg-white rounded-2xl border p-2.5 sm:p-3 shadow-xs transition-colors ${isSelected ? 'border-teal-300 ring-1 ring-teal-100' : 'border-slate-200/80 opacity-75'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <button type="button" onClick={() => onToggleSelect(med.id)} className="mt-0.5 text-teal-700 shrink-0 transition hover:scale-105 active:scale-95">
            {isSelected ? <CheckSquare className="w-4.5 h-4.5 text-teal-700" /> : <Square className="w-4.5 h-4.5 text-slate-300" />}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h4 className="font-bold text-slate-900 text-xs sm:text-sm leading-tight">{med.name}</h4>
              <span className={`inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded border leading-none ${
                status === 'out_of_stock' ? 'bg-red-50 text-red-700 border-red-200' :
                status === 'critical' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                'bg-emerald-50 text-emerald-700 border-emerald-200'
              }`}>{status === 'out_of_stock' ? 'نفد' : status === 'critical' ? 'حرج' : 'آمن'}</span>
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 leading-tight">
              المتبقي: <strong className="font-mono text-slate-700">{med.currentPills}</strong> • ينفد {formatDepletionDate(depletion.dateStr, depletion.daysLeft, Number(med.currentPills) || 0)}
            </div>
          </div>
        </div>
        <button type="button" onClick={() => onRemoveFromShopping(med.id)} aria-label={`إزالة ${med.name} من قائمة الشراء`} title="إزالة من قائمة الشراء" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 active:scale-95">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 pt-2 border-t border-slate-100 space-y-1.5">
        <div className="flex items-start justify-between gap-1.5">
          <div className="shrink-0">
            <SegmentedButton<'period' | 'custom'>
              className="w-[180px] shrink-0"
              size="sm"
              value={getQuantityMode(med)}
              onChange={(val) => onToggleQuantityMode(med, val, suggestedPills)}
              options={[{ value: 'period', label: 'حسب الفترة' }, { value: 'custom', label: 'كمية محددة' }]}
              aria-label={`طريقة حساب كمية طلب ${med.name}`}
            />
          </div>
          {availableUnits.length > 1 ? (
            <div className="flex items-start gap-1 shrink-0">
              {availableUnits.map((u) => {
                const isActive = selectedUnits.includes(u);
                const icon = u === 'pills'
                  ? <Pill className="w-2.5 h-2.5" />
                  : u === 'boxes'
                  ? <Box className="w-2.5 h-2.5" />
                  : <Layers className="w-2.5 h-2.5" />;
                const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
                const label = u === 'pills' ? med.unit : u === 'boxes' ? boxLabel : 'شريط';
                const inputValue = getCustomQuantityInputValue(med, u, suggestedPills);
                return (
                  <div key={u} className="flex flex-col items-stretch gap-1 w-[3.75rem] shrink-0">
                    <button type="button" onClick={() => onToggleOrderUnit(med, u, suggestedPills)} aria-pressed={isActive}
                      className={`w-full h-[28px] px-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1 transition cursor-pointer border select-none ${isActive ? 'bg-teal-100 text-teal-950 border-teal-300 shadow-2xs' : 'bg-slate-50/80 text-slate-600 border-slate-200/90 hover:bg-slate-100'}`}>
                      {icon}<span className="whitespace-nowrap">{label}</span>
                    </button>
                    {getQuantityMode(med) === 'custom' && isActive && (
                      <input type="number" min="1" value={inputValue}
                        onChange={(event) => onCustomQuantityChange(med, u, event.target.value)}
                        className="w-full min-w-0 box-border rounded-md border border-slate-300 bg-white px-1 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                        aria-label={`كمية ${med.name} ${label}`} />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            getQuantityMode(med) === 'custom' &&
            selectedUnits.map((unit) => {
              const inputValue = getCustomQuantityInputValue(med, unit, suggestedPills);
              const boxLabel = med.unit === 'مل' ? 'عبوة' : 'علبة';
              const label = unit === 'pills' ? med.unit : unit === 'boxes' ? boxLabel : 'شريط';
              return (
                <input key={unit} type="number" min="1" value={inputValue}
                  onChange={(event) => onCustomQuantityChange(med, unit, event.target.value)}
                  className="w-[3.75rem] shrink-0 box-border rounded-md border border-slate-300 bg-white px-1 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                  aria-label={`كمية ${med.name} ${label}`} />
              );
            })
          )}
        </div>

        {getQuantityMode(med) === 'period' && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-teal-100/90 bg-teal-50/40 px-2.5 py-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-teal-900">مدة الطلب</span>
              <div className="flex items-center gap-1">
                <input type="number" min="1" value={getMedicationPeriod(med).value}
                  onChange={(event) => onMedicationPeriodChange(med.id, 'value', event.target.value)}
                  className="w-12 rounded-md border border-teal-200 bg-white px-1 py-0.5 text-center font-mono font-bold text-xs focus:ring-1 focus:ring-teal-500"
                  aria-label={`عدد مدة طلب ${med.name}`} />
                <select value={getMedicationPeriod(med).unit}
                  onChange={(event) => onMedicationPeriodChange(med.id, 'unit', event.target.value)}
                  className="rounded-md border border-teal-200 bg-white px-1.5 py-0.5 font-bold text-xs text-teal-900 outline-none cursor-pointer"
                  aria-label={`وحدة مدة طلب ${med.name}`}>
                  <option value="day">يوم</option><option value="month">شهر</option>
                </select>
              </div>
            </div>
            {selectedUnits.map((unit) => {
              const unitQty = getUnitQuantity(med, unit, suggestedPills);
              return <span key={unit} className="text-[11px] text-teal-900 font-bold bg-white/90 border border-teal-200/80 rounded-md px-2 py-0.5 shadow-2xs">{unitLabel(unit, med, unitQty)}</span>;
            })}
          </div>
        )}

        <div className="text-[10.5px] text-teal-800 text-left font-medium px-0.5">
          الإجمالي:{' '}
          {getQuantityMode(med) === 'custom'
            ? describeOrderQuantityBreakdown(getOrderBreakdown(med, suggestedPills) || [], med.unit)
            : describeOrderInBoxes(requestedPills, med.stripsPerBox, med.pillsPerStrip, med.packageSize, med.unit)}
          {getQuantityMode(med) === 'custom' && requestedPills > 0 ? ` (${pluralizeArabic(requestedPills, med.unit)})` : ''}
        </div>
      </div>
    </div>
  );
};
