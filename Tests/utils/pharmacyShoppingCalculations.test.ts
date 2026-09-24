import { describe, expect, it } from 'vitest';
import type { Medication } from '@/types';
import {
  getShoppingAvailableUnits,
  getShoppingUnitSize,
  shoppingRequestedPills,
  getMedicationPeriod,
  getDurationDays,
  getQuantityMode,
  getSelectedUnits,
  getUnitQuantity,
  getCustomQuantityInputValue,
  getOrderBreakdown,
  unitLabel,
  type CustomOrderQuantities,
  type MedicationPeriod,
  type OrderUnit,
  type QuantityMode,
} from '@/utils/pharmacyShoppingCalculations';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    ...overrides,
  };
}

describe('pharmacy shopping calculations', () => {
  it('derives order units and their pill sizes from medication packaging', () => {
    const med = makeMed({ stripsPerBox: 3, pillsPerStrip: 10, packageSize: 30 });
    expect(getShoppingAvailableUnits(med)).toEqual(['strips', 'boxes']);
    expect(getShoppingUnitSize(med, 'strips')).toBe(10);
    expect(getShoppingUnitSize(med, 'boxes')).toBe(30);
  });

  it('normalizes the configured shopping period from days and months', () => {
    const med = makeMed();
    const empty: Record<string, MedicationPeriod> = {};
    expect(getMedicationPeriod(empty, med, 60)).toEqual({ value: 2, unit: 'month' });
    expect(getDurationDays(empty, med, 60)).toBe(60);
    expect(getMedicationPeriod(empty, med, 30)).toEqual({ value: 30, unit: 'day' });
    expect(getDurationDays(empty, med, 30)).toBe(30);
  });

  it('keeps custom multi-unit quantities additive', () => {
    const med = makeMed({ stripsPerBox: 3, pillsPerStrip: 10, packageSize: 30 });
    const quantityModes: Record<string, QuantityMode> = { [med.id]: 'custom' };
    const customOrderQuantities: CustomOrderQuantities = {
      [med.id]: { strips: 2, boxes: 1 },
    };
    const orderUnits: Record<string, OrderUnit[]> = {
      [med.id]: ['strips', 'boxes'],
    };

    expect(shoppingRequestedPills(
      med,
      12,
      quantityModes,
      customOrderQuantities,
      orderUnits
    )).toBe(50);
    expect(getSelectedUnits(orderUnits, med)).toEqual(['strips', 'boxes']);
    expect(getQuantityMode(quantityModes, med)).toBe('custom');
    expect(getUnitQuantity(customOrderQuantities, quantityModes, med, 'strips', 12)).toBe(2);
    expect(getCustomQuantityInputValue(customOrderQuantities, med, 'boxes', 12)).toBe(1);
    expect(getOrderBreakdown(
      customOrderQuantities,
      orderUnits,
      quantityModes,
      med,
      12
    )).toEqual([
      { unit: 'strips', quantity: 2 },
      { unit: 'boxes', quantity: 1 },
    ]);
  });

  it('falls back to suggested quantity and preserves Arabic unit labels', () => {
    const med = makeMed({ stripsPerBox: 3, pillsPerStrip: 10, packageSize: 30 });
    expect(shoppingRequestedPills(med, 31, {}, {}, {})).toBe(31);
    expect(unitLabel('boxes', med, 1)).toBe('علبة واحدة');
    expect(unitLabel('strips', med, 2)).toBe('شريطين');
  });
});
