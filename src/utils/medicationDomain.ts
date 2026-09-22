import type { Medication } from '../types';

export function getCriticalThresholdDays(med: Medication): number {
  const value = Number(med.warningThresholdDays);
  return !Number.isNaN(value) && value >= 1 ? Math.floor(value) : 5;
}
