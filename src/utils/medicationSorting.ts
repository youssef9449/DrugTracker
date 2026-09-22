import type { Medication } from '../types';

export type MedicationSortField = 'name' | 'quantity' | 'category' | 'duration';
export type MedicationSortDirection = 'asc' | 'desc';

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('ar-EG').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
}

function getScriptRank(str: string): number {
  if (!str) return 99;
  const ch = str.charAt(0);
  // Latin / English characters FIRST (requested: English priority over Arabic)
  if (/[A-Za-z]/.test(ch)) return 1;
  // Arabic Unicode ranges SECOND
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(ch)) return 2;
  // Digits
  if (/[0-9]/.test(ch)) return 3;
  return 4;
}

function compareText(a: string | undefined, b: string | undefined): number {
  const av = normalizeText(a);
  const bv = normalizeText(b);
  if (!av && bv) return 1;
  if (av && !bv) return -1;
  if (!av && !bv) return 0;

  const rankA = getScriptRank(av);
  const rankB = getScriptRank(bv);
  if (rankA !== rankB) return rankA - rankB;

  // Use appropriate locale collator based on the script: 'en' for English/Latin, 'ar-EG' for Arabic
  const locale = rankA === 1 ? 'en' : 'ar-EG';
  return av.localeCompare(bv, locale, { sensitivity: 'base', numeric: true });
}

function compareName(a: Medication, b: Medication): number {
  const result = compareText(a.name, b.name);
  return result !== 0 ? result : a.id.localeCompare(b.id);
}

function getDurationValue(med: Medication): number {
  // Chronic medications are continuous (infinite / long term)
  if (med.isChronic) return 999999;
  if (typeof med.durationDays === 'number' && Number.isFinite(med.durationDays) && med.durationDays > 0) {
    return med.durationDays;
  }
  return 999999;
}

export function sortMedications(medications: Medication[], field: MedicationSortField, direction: MedicationSortDirection): Medication[] {
  const sorted = [...medications];
  sorted.sort((a, b) => {
    if (field === 'category') {
      const aMissing = !normalizeText(a.category);
      const bMissing = !normalizeText(b.category);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
    }

    let result = 0;
    if (field === 'name') {
      result = compareName(a, b);
    } else if (field === 'quantity') {
      const qA = Number.isFinite(Number(a.currentPills)) ? Number(a.currentPills) : 0;
      const qB = Number.isFinite(Number(b.currentPills)) ? Number(b.currentPills) : 0;
      result = qA - qB;
    } else if (field === 'duration') {
      const dA = getDurationValue(a);
      const dB = getDurationValue(b);
      result = dA - dB;
    } else {
      result = compareText(a.category, b.category);
    }

    if (result === 0 && field !== 'name') result = compareName(a, b);
    return direction === 'asc' ? result : -result;
  });
  return sorted;
}
