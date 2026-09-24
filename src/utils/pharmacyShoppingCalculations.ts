import type { Medication } from '../types';
import { pluralizeArabic } from '../lib/arabicPlural';
import { getMedSizes } from './medicationPackaging';

export type OrderUnit = 'pills' | 'boxes' | 'strips';
export type CustomOrderQuantities = Record<string, Partial<Record<OrderUnit, number | ''>>>;
export type PeriodUnit = 'day' | 'month';
export type MedicationPeriod = { value: number | ''; unit: PeriodUnit };
export type QuantityMode = 'period' | 'custom';

export function getShoppingAvailableUnits(med: Medication): OrderUnit[] {
  const { boxSize, stripSize, hasStrips } = getMedSizes(med);
  if (hasStrips && stripSize > 0) return boxSize > 0 ? ['strips', 'boxes'] : ['strips'];
  if ((med.unit === 'كيس' || med.unit === 'جرعة') && boxSize > 0) return ['pills', 'boxes'];
  return ['boxes'];
}

export function getShoppingDefaultUnits(med: Medication): OrderUnit[] {
  return [getShoppingAvailableUnits(med)[0]];
}

export function getShoppingUnitSize(med: Medication, unit: OrderUnit): number {
  const { boxSize, stripSize } = getMedSizes(med);
  if (unit === 'boxes') return boxSize > 0 ? boxSize : 1;
  if (unit === 'strips') return stripSize > 0 ? stripSize : 1;
  return 1;
}

export function shoppingUnitToPills(med: Medication, unit: OrderUnit, quantity: number): number {
  return quantity * getShoppingUnitSize(med, unit);
}

export function shoppingRequestedPills(med: Medication, suggestedPills: number, quantityModes: Record<string, QuantityMode>, customOrderQuantities: CustomOrderQuantities, orderUnits: Record<string, OrderUnit[]>): number {
  const mode = quantityModes[med.id] || 'period';
  if (mode !== 'custom') return suggestedPills;
  const selectedUnits = orderUnits[med.id] || getShoppingDefaultUnits(med);
  return selectedUnits.reduce((total, unit) => {
    const stored = customOrderQuantities[med.id]?.[unit];
    const unitQty = stored === '' ? 0 : stored ?? Math.max(1, Math.ceil(suggestedPills / getShoppingUnitSize(med, unit)));
    return total + shoppingUnitToPills(med, unit, unitQty);
  }, 0);
}

export function getMedicationPeriod(medicationPeriods: Record<string, MedicationPeriod>, med: Medication, defaultDurationDays: number | undefined): MedicationPeriod {
  return medicationPeriods[med.id] || {
    value: defaultDurationDays === 60 ? 2 : 30,
    unit: defaultDurationDays === 60 ? 'month' : 'day',
  };
}

export function getDurationDays(medicationPeriods: Record<string, MedicationPeriod>, med: Medication, defaultDurationDays: number | undefined): number {
  const period = getMedicationPeriod(medicationPeriods, med, defaultDurationDays);
  const rawValue = period.value === '' ? 1 : period.value;
  return Math.max(1, rawValue || 1) * (period.unit === 'month' ? 30 : 1);
}

export function getQuantityMode(quantityModes: Record<string, QuantityMode>, med: Medication): QuantityMode {
  return quantityModes[med.id] || 'period';
}

export function getSelectedUnits(orderUnits: Record<string, OrderUnit[]>, med: Medication): OrderUnit[] {
  return orderUnits[med.id] || getShoppingDefaultUnits(med);
}

export function getUnitQuantity(customOrderQuantities: CustomOrderQuantities, quantityModes: Record<string, QuantityMode>, med: Medication, unit: OrderUnit, suggestedPills: number): number {
  if (getQuantityMode(quantityModes, med) === 'custom') {
    const stored = customOrderQuantities[med.id]?.[unit];
    if (stored === '') return 0;
    if (stored !== undefined) return stored;
  }
  return Math.max(1, Math.ceil(suggestedPills / getShoppingUnitSize(med, unit)));
}

export function getCustomQuantityInputValue(customOrderQuantities: CustomOrderQuantities, med: Medication, unit: OrderUnit, suggestedPills: number): number | '' {
  const stored = customOrderQuantities[med.id]?.[unit];
  if (stored !== undefined) return stored;
  return Math.max(1, Math.ceil(suggestedPills / getShoppingUnitSize(med, unit)));
}

export function getRequestedPills(quantityModes: Record<string, QuantityMode>, customOrderQuantities: CustomOrderQuantities, orderUnits: Record<string, OrderUnit[]>, med: Medication, suggestedPills: number): number {
  return shoppingRequestedPills(med, suggestedPills, quantityModes, customOrderQuantities, orderUnits);
}

export function getOrderBreakdown(customOrderQuantities: CustomOrderQuantities, orderUnits: Record<string, OrderUnit[]>, quantityModes: Record<string, QuantityMode>, med: Medication, suggestedPills: number): { unit: OrderUnit; quantity: number }[] {
  if (getQuantityMode(quantityModes, med) !== 'custom') return [];
  return getSelectedUnits(orderUnits, med).map((unit) => ({
    unit,
    quantity: getUnitQuantity(customOrderQuantities, orderUnits, quantityModes, med, unit, suggestedPills),
  })).filter((item) => item.quantity > 0);
}

export function unitLabel(unit: OrderUnit, med: Medication, count: number): string {
  if (unit === 'pills') return pluralizeArabic(count, med.unit);
  if (unit === 'boxes') return pluralizeArabic(count, med.unit === 'مل' ? 'عبوة' : 'علبة');
  return pluralizeArabic(count, 'شريط');
}