import type { Medication, MedicationStatusInfo } from '../types';
import { NEVER_DEPLETES_DAYS } from './time';
import { getCriticalThresholdDays } from './medicationDomain';
import { dailyScheduleAmount, daysLeftFromCurrentStock } from './dateCalculations';
export { getCriticalThresholdDays } from './medicationDomain';export function calculateMedicationStatus(med:Medication):MedicationStatusInfo{const pills=Number(med.currentPills)||0;const days=daysLeftFromCurrentStock(med);if(pills<=0)return{daysLeft:0,status:'out_of_stock'};if(dailyScheduleAmount(med)<=0)return{daysLeft:NEVER_DEPLETES_DAYS,status:'sufficient'};return days<=getCriticalThresholdDays(med)?{daysLeft:days,status:'critical'}:{daysLeft:days,status:'sufficient'};}
