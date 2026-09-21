import { describe, expect, it } from 'vitest';
import type { Medication } from '../../src/types';
import { sortMedications } from '../../src/utils/medicationSorting';

const med = (o: Partial<Medication>): Medication => ({
  id: o.id ?? 'id', name: o.name ?? 'دواء', currentPills: o.currentPills ?? 0,
  dailyDose: 1, unit: 'قرص', warningThresholdDays: 5, colorTag: 'teal',
  createdAt: '2026-01-01T00:00:00.000Z', ...o,
});

describe('sortMedications', () => {
  const meds = [
    med({ id: '1', name: 'باراسيتامول', currentPills: 20, category: 'مسكنات' }),
    med({ id: '2', name: 'أموكسيسيلين', currentPills: 5, category: 'مضادات حيوية' }),
    med({ id: '3', name: 'فيتامين د', currentPills: 50 }),
  ];
  it('sorts names ascending and descending', () => {
    expect(sortMedications(meds, 'name', 'asc').map(m => m.name)).toEqual(['أموكسيسيلين', 'باراسيتامول', 'فيتامين د']);
    expect(sortMedications(meds, 'name', 'desc').map(m => m.name)).toEqual(['فيتامين د', 'باراسيتامول', 'أموكسيسيلين']);
  });
  it('sorts available quantity in both directions', () => {
    expect(sortMedications(meds, 'quantity', 'asc').map(m => m.id)).toEqual(['2', '1', '3']);
    expect(sortMedications(meds, 'quantity', 'desc').map(m => m.id)).toEqual(['3', '1', '2']);
  });
  it('sorts categories and keeps missing categories last', () => {
    expect(sortMedications(meds, 'category', 'asc').map(m => m.name)).toEqual(['باراسيتامول', 'أموكسيسيلين', 'فيتامين د']);
    expect(sortMedications(meds, 'category', 'desc').map(m => m.name)).toEqual(['أموكسيسيلين', 'باراسيتامول', 'فيتامين د']);
  });
  it('does not mutate the source array and uses name as a tie-breaker', () => {
    const same = [med({id:'a',name:'زنك',currentPills:10}), med({id:'b',name:'أسبرين',currentPills:10})];
    expect(sortMedications(same, 'quantity', 'asc').map(m => m.name)).toEqual(['أسبرين', 'زنك']);
    expect(same.map(m => m.id)).toEqual(['a', 'b']);
  });
});