import type { Medication, MedicationStatusInfo } from '../types';
import { NEVER_DEPLETES_DAYS } from './time';
import { getCriticalThresholdDays } from './medicationDomain';
import { dailyScheduleAmount, daysLeftFromCurrentStock } from './dateCalculations';

export { getCriticalThresholdDays } from './medicationDomain';

export function calculateMedicationStatus(
  med: Medication
): MedicationStatusInfo {
  const pills = Number(med.currentPills) || 0;
  const days = daysLeftFromCurrentStock(med);

  if (pills <= 0) {
    return { daysLeft: 0, status: 'out_of_stock' };
  }

  const dailyAmount = dailyScheduleAmount(med);
  if (dailyAmount <= 0) {
    return { daysLeft: NEVER_DEPLETES_DAYS, status: 'sufficient' };
  }

  // A fixed treatment course is safe only when the current stock covers
  // the selected course duration. Chronic medications retain the existing
  // warning-threshold logic.
  if (
    med.isChronic === false &&
    typeof med.durationDays === 'number' &&
    med.durationDays > 0
  ) {
    return days >= med.durationDays
      ? { daysLeft: days, status: 'sufficient' }
      : { daysLeft: days, status: 'critical' };
  }

  return days <= getCriticalThresholdDays(med)
    ? { daysLeft: days, status: 'critical' }
    : { daysLeft: days, status: 'sufficient' };
}
