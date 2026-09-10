import { describe, it, expect } from 'vitest';
import { getMedSizes } from './medicationPackaging';
import type { Medication } from '../types';

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
    lastSyncDate: '2024-01-01',
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
