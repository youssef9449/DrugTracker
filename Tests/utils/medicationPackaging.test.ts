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
import { describeStockInStrips, normalizeDisplayQuantity } from '@/types';

describe('normalizeDisplayQuantity', () => {
  it('preserves genuine fractions', () => {
    expect(normalizeDisplayQuantity(0.5)).toBe(0.5);
    expect(normalizeDisplayQuantity(1.5)).toBe(1.5);
    expect(normalizeDisplayQuantity(2.25)).toBe(2.25);
  });

  it('collapses float noise near integers', () => {
    expect(normalizeDisplayQuantity(3 + 1e-12)).toBe(3);
    expect(normalizeDisplayQuantity(10 - 1e-12)).toBe(10);
  });

  it('trims binary float garbage', () => {
    expect(normalizeDisplayQuantity(0.1 + 0.2)).toBe(0.3);
  });
});

describe('describeStockInStrips — fractional remainders', () => {
  it('Case A: 0.5 does not round to 1', () => {
    const s = describeStockInStrips(0.5, 10, 3, 'قرص');
    expect(s).toBeTruthy();
    expect(s!).toContain('0.5');
    expect(s!).not.toMatch(/^قرص واحد$/);
    expect(s!).not.toContain('1 ');
  });

  it('Case B: 1.5 preserves 1.5', () => {
    const s = describeStockInStrips(1.5, 10, 3, 'قرص');
    expect(s).toBeTruthy();
    expect(s!).toContain('1.5');
  });

  it('Case C: 2.25 preserves 2.25 without float garbage', () => {
    const s = describeStockInStrips(2.25, 10, 3, 'قرص');
    expect(s).toBeTruthy();
    expect(s!).toContain('2.25');
    expect(s!).not.toContain('000000');
  });

  it('Case D: whole-number strip packaging unchanged (30 = 1 box)', () => {
    const s = describeStockInStrips(30, 10, 3, 'قرص');
    expect(s).toBe(describeStockInStrips(30, 10, 3, 'قرص'));
    // 30 pills / 10 per strip / 3 strips per box → 1 box
    expect(s).toMatch(/علبة/);
  });

  it('Case E: whole-number without strip packaging path via formatScheduledDoseBreakdown', () => {
    const med = makeMed({
      unit: 'قرص',
      packageSize: 30,
      pillsPerStrip: undefined,
      stripsPerBox: undefined,
      doseSchedule: [
        { id: 'd1', time: '08:00', amount: 1 },
      ],
    });
    // daily 1 → "قرص واحد" style integer path
    const text = formatScheduledDoseBreakdown(med, true);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('0.000');
  });
});

describe('formatScheduledDoseBreakdown — fractional daily dose', () => {
  it('preserves half-unit daily dose in display', () => {
    const med = makeMed({
      unit: 'قرص',
      pillsPerStrip: 10,
      stripsPerBox: 3,
      doseSchedule: [{ id: 'd1', time: '08:00', amount: 0.5 }],
    });
    const text = formatScheduledDoseBreakdown(med, true);
    expect(text).toContain('0.5');
    expect(text).not.toMatch(/قرص واحد/);
  });

  it('preserves 1.5 daily dose', () => {
    const med = makeMed({
      unit: 'قرص',
      pillsPerStrip: 10,
      stripsPerBox: 3,
      doseSchedule: [{ id: 'd1', time: '08:00', amount: 1.5 }],
    });
    const text = formatScheduledDoseBreakdown(med, true);
    expect(text).toContain('1.5');
  });
});
