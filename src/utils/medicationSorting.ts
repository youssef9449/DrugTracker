import type { Medication } from '../types';

export type MedicationSortField = 'name' | 'quantity' | 'category';
export type MedicationSortDirection = 'asc' | 'desc';

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('ar-EG').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
}

function compareText(a: string | undefined, b: string | undefined): number {
  const av = normalizeText(a);
  const bv = normalizeText(b);
  if (!av && bv) return 1;
  if (av && !bv) return -1;
  return av.localeCompare(bv, 'ar-EG', { sensitivity: 'base', numeric: true });
}

function compareName(a: Medication, b: Medication): number {
  const result = compareText(a.name, b.name);
  return result !== 0 ? result : a.id.localeCompare(b.id);
}

export function sortMedications(medications: Medication[], field: MedicationSortField, direction: MedicationSortDirection): Medication[] {
  const sorted = [...medications];
  sorted.sort((a, b) => {
    if (field === 'category') {
      const aMissing = !normalizeText(a.category);
      const bMissing = !normalizeText(b.category);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
    }

    let result = field === 'name' ? compareName(a, b) : field === 'quantity'
      ? (Number.isFinite(Number(a.currentPills)) ? Number(a.currentPills) : 0) - (Number.isFinite(Number(b.currentPills)) ? Number(b.currentPills) : 0)
      : compareText(a.category, b.category);
    if (result === 0 && field !== 'name') result = compareName(a, b);
    return direction === 'asc' ? result : -result;
  });
  return sorted;
}
