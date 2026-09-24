import type { Dispatch, SetStateAction } from 'react';
import type { Medication, ConsumptionLog } from '../types';

export interface MedicationHandlersDeps {
  medications: Medication[];
  logs: ConsumptionLog[];
  soundEnabled: boolean;
  globalAutoDeductEnabled: boolean;
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  selectDoseMode: 'take' | 'restore' | 'manage';
  setMedications: Dispatch<SetStateAction<Medication[]>>;
  setLogs: Dispatch<SetStateAction<ConsumptionLog[]>>;
  setGlobalAutoDeductEnabled: Dispatch<SetStateAction<boolean>>;
  setIsAutoDeductPromptOpen: Dispatch<SetStateAction<boolean>>;
  setIsFirstRun: Dispatch<SetStateAction<boolean>>;
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>;
  setCriticalStockAlertsEnabled: Dispatch<SetStateAction<boolean>>;
  setSelectDoseMed: Dispatch<SetStateAction<Medication | null>>;
  setSelectDoseMode: Dispatch<SetStateAction<'take' | 'restore' | 'manage'>>;
  setEditingMedication: Dispatch<SetStateAction<Medication | null>>;
  showToast: (message: string) => void;
  dismissAlarm: () => boolean;
  snoozeAlarm: (minutes?: number) => void;
}

export interface MedicationHandlerState {
  medicationsRef: { current: Medication[] };
  selectDoseModeRef: { current: MedicationHandlersDeps['selectDoseMode'] };
  globalAutoDeductEnabledRef: { current: boolean };
  restoreInFlightRef: { current: Set<string> };
  refillUndoInFlightRef: { current: Set<string> };
}
