import { describe, it, expect } from 'vitest';
import { getMedSizes } from '@/utils/medicationPackaging';
import type { Medication } from '@/types';

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

describe('getMedSizes (#73)', () => {
  it('computes boxSize from stripsPerBox × pillsPerStrip for solid meds with strips', () => {
    const med = makeMed({ unit: 'قرص', stripsPerBox: 3, pillsPerStrip: 10 });
    const sizes = getMedSizes(med);
    expect(sizes.boxSize).toBe(30);
    expect(sizes.stripSize).toBe(10);
    expect(sizes.hasStrips).toBe(true);
    expect(sizes.isSolid).toBe(true);
  });

  it('uses packageSize when strips are not defined (solid med)', () => {
    const med = makeMed({ unit: 'قرص', packageSize: 30 });
    const sizes = getMedSizes(med);
    expect(sizes.boxSize).toBe(30);
    expect(sizes.stripSize).toBe(0);
    expect(sizes.hasStrips).toBe(false);
    expect(sizes.isSolid).toBe(true);
  });

  it('defaults to 30 for solid units when no packaging info', () => {
    const med = makeMed({ unit: 'كبسولة' });
    const sizes = getMedSizes(med);
    expect(sizes.boxSize).toBe(30);
    expect(sizes.hasStrips).toBe(false);
    expect(sizes.isSolid).toBe(true);
  });

  it('defaults to 100 for liquid (ml) units', () => {
    const med = makeMed({ unit: 'مل' });
    const sizes = getMedSizes(med);
    expect(sizes.boxSize).toBe(100);
    expect(sizes.hasStrips).toBe(false);
    expect(sizes.isSolid).toBe(false);
  });

  it('treats strips as absent when stripsPerBox or pillsPerStrip is 0', () => {
    const med = makeMed({ unit: 'قرص', stripsPerBox: 0, pillsPerStrip: 10 });
    const sizes = getMedSizes(med);
    expect(sizes.hasStrips).toBe(false);
    expect(sizes.boxSize).toBe(30);
  });

  it('treats strips as absent for non-solid units even if stripsPerBox is set', () => {
    const med = makeMed({ unit: 'مل', stripsPerBox: 3, pillsPerStrip: 10 });
    const sizes = getMedSizes(med);
    expect(sizes.hasStrips).toBe(false);
    expect(sizes.isSolid).toBe(false);
  });

  it('never uses non-null assertions — narrows via local consts (#98)', () => {
    // This is a compile-time guarantee; the runtime test confirms correctness.
    // stripsPerBox=2, pillsPerStrip=15 → boxSize = 30, stripSize = 15.
    const med = makeMed({ unit: 'قرص', stripsPerBox: 2, pillsPerStrip: 15 });
    const sizes = getMedSizes(med);
    expect(sizes.boxSize).toBe(30);
    expect(sizes.stripSize).toBe(15);
  });
});

import {
  formatScheduledDoseBreakdown,
} from '@/utils/medicationPackaging';
import { describeStockInStrips, normalizeDisplayQuantity, formatUnitQuantity } from '@/utils/medicationPackaging';

describe('normalizeDisplayQuantity', () => {
  it('Case A: collapses true IEEE-754 noise near integers', () => {
    const up = 3 + Number.EPSILON * 3 * 4;
    const down = 10 - Number.EPSILON * 10 * 4;
    expect(normalizeDisplayQuantity(up)).toBe(3);
    expect(normalizeDisplayQuantity(down)).toBe(10);
  });

  it('Case B: common binary float artifact 0.1 + 0.2 → 0.3', () => {
    expect(normalizeDisplayQuantity(0.1 + 0.2)).toBe(0.3);
  });

  it('Case C: genuine tiny non-zero fractions must not become 0', () => {
    expect(normalizeDisplayQuantity(0.0000000005)).toBe(0.0000000005);
    expect(normalizeDisplayQuantity(0.0000000009)).toBe(0.0000000009);
  });

  it('Case D: genuine high-precision fraction equals original', () => {
    const v = 0.1234567891234567;
    expect(normalizeDisplayQuantity(v)).toBe(v);
  });

  it('Case E: ordinary genuine fractions unchanged', () => {
    expect(normalizeDisplayQuantity(0.5)).toBe(0.5);
    expect(normalizeDisplayQuantity(1.5)).toBe(1.5);
    expect(normalizeDisplayQuantity(2.25)).toBe(2.25);
  });
});

describe('formatUnitQuantity', () => {
  it('whole numbers use Arabic pluralization', () => {
    expect(formatUnitQuantity(1, 'قرص')).toBe('قرص واحد');
    expect(formatUnitQuantity(2, 'قرص')).toBe('قرصين');
    expect(formatUnitQuantity(3, 'قرص')).toBe('3 أقراص');
  });

  it('Case E: fractions use numeric quantity + unit, not pluralizeArabic', () => {
    expect(formatUnitQuantity(0.5, 'قرص')).toBe('0.5 قرص');
    expect(formatUnitQuantity(1.5, 'قرص')).toBe('1.5 قرص');
    expect(formatUnitQuantity(2.25, 'قرص')).toBe('2.25 قرص');
  });

  it('Case F formatter: tiny and high-precision fractions preserved in text', () => {
    expect(formatUnitQuantity(0.0000000005, 'قرص')).toBe('5e-10 قرص');
    const v = 0.1234567891234567;
    expect(formatUnitQuantity(v, 'قرص')).toBe(`${v} قرص`);
  });

  it('Case F: whole-number Arabic forms remain unchanged', () => {
    expect(formatUnitQuantity(1, 'قرص')).toBe('قرص واحد');
    expect(formatUnitQuantity(2, 'قرص')).toBe('قرصين');
    expect(formatUnitQuantity(3, 'قرص')).toBe('3 أقراص');
  });

  it('float noise near integers still uses integer Arabic forms', () => {
    expect(formatUnitQuantity(3 + 1e-12, 'قرص')).toBe('3 أقراص');
  });
});

describe('describeStockInStrips — fractional remainders', () => {
  it('Case A: 0.5 قرص exact fractional presentation', () => {
    const s = describeStockInStrips(0.5, 10, 3, 'قرص');
    expect(s).toBe('0.5 قرص');
    expect(s).not.toContain('قرص واحد');
  });

  it('Case B: 1.5 قرص exact, not rounded to 2', () => {
    const s = describeStockInStrips(1.5, 10, 3, 'قرص');
    expect(s).toBe('1.5 قرص');
    expect(s).not.toMatch(/2 /);
  });

  it('Case C: 2.25 قرص without float garbage', () => {
    const s = describeStockInStrips(2.25, 10, 3, 'قرص');
    expect(s).toBe('2.25 قرص');
    expect(s).not.toContain('000000');
  });

  it('Case D: whole-number strip packaging is علبة واحدة', () => {
    // 30 pills / 10 per strip / 3 strips per box → exactly 1 box
    expect(describeStockInStrips(30, 10, 3, 'قرص')).toBe('علبة واحدة');
  });

  it('Case E: whole-number without strip packaging uses integer Arabic form', () => {
    const med = makeMed({
      unit: 'قرص',
      packageSize: 30,
      pillsPerStrip: undefined,
      stripsPerBox: undefined,
      doseSchedule: [
        { id: 'd1', time: '08:00', amount: 1 },
      ],
    });
    const text = formatScheduledDoseBreakdown(med, true);
    expect(text).toBe('قرص واحد');
  });
});

describe('formatScheduledDoseBreakdown — fractional daily dose', () => {
  it('0.5 daily dose is exact fractional presentation', () => {
    const med = makeMed({
      unit: 'قرص',
      pillsPerStrip: 10,
      stripsPerBox: 3,
      doseSchedule: [{ id: 'd1', time: '08:00', amount: 0.5 }],
    });
    const text = formatScheduledDoseBreakdown(med, true);
    expect(text).toBe('0.5 قرص');
    expect(text).not.toContain('قرص واحد');
  });

  it('1.5 daily dose is exact fractional presentation', () => {
    const med = makeMed({
      unit: 'قرص',
      pillsPerStrip: 10,
      stripsPerBox: 3,
      doseSchedule: [{ id: 'd1', time: '08:00', amount: 1.5 }],
    });
    const text = formatScheduledDoseBreakdown(med, true);
    expect(text).toBe('1.5 قرص');
  });
});
