import { describe, expect, it } from 'vitest';
import {
  calculatePackageConfiguration,
  calculateStockHelperTotal,
  calculateStripBasedPackageSize,
} from '@/utils/addMedicationFormCalculations';

describe('add medication form calculations', () => {
  it('computes strip-based package size with minimum valid counts', () => {
    expect(calculateStripBasedPackageSize('3', '10')).toBe(30);
    expect(calculateStripBasedPackageSize('', '0')).toBe(1);
  });

  it('calculates stock helper totals as boxes + strips + loose units', () => {
    expect(calculateStockHelperTotal('3', '10', '2', '1', '4')).toBe(74);
    expect(calculateStockHelperTotal('3', '10', '0', '0', '7')).toBe(7);
  });

  it('keeps non-solid package sizing independent of strip fields', () => {
    expect(calculatePackageConfiguration({
      unit: 'مل',
      noStrips: false,
      packageSize: 100,
      stripsPerBox: '9',
      pillsPerStrip: '99',
    })).toEqual({
      stripsPerBoxNum: undefined,
      pillsPerStripNum: undefined,
      calculatedPkgSize: 100,
    });
  });

  it('supports solid loose-pill boxes without strip metadata', () => {
    expect(calculatePackageConfiguration({
      unit: 'قرص',
      noStrips: true,
      packageSize: 15,
      stripsPerBox: '4',
      pillsPerStrip: '10',
    })).toEqual({
      stripsPerBoxNum: undefined,
      pillsPerStripNum: undefined,
      calculatedPkgSize: 4,
    });
  });
});
