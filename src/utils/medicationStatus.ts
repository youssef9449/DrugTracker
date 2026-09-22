import type { Medication, MedicationStatusInfo } from '../types';
import { NEVER_DEPLETES_DAYS } from './time';
import { getCriticalThresholdDays } from './medicationDomain';
import { dailyScheduleAmount, daysLeftFromCurrentStock } from './dateCalculations';

export { getCriticalThresholdDays } from './medicationDomain';

export function calculateMedicationStatus(
  med: Medication
): MedicationStatusInfo {
  const currentPills = Number(med.currentPills) || 0;
  const daysLeft = daysLeftFromCurrentStock(med);

  if (currentPills <= 0) {
    return { daysLeft: 0, status: 'out_of_stock' };
  }

  if (dailyScheduleAmount(med) <= 0) {
    return { daysLeft: NEVER_DEPLETES_DAYS, status: 'sufficient' };
  }

  return daysLeft <= getCriticalThresholdDays(med)
    ? { daysLeft, status: 'critical' }
    : { daysLeft, status: 'sufficient' };
}
