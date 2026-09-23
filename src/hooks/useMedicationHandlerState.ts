import { useRef } from 'react';
import type { Medication } from '../types';
import type { MedicationHandlerState, MedicationHandlersDeps } from './medicationHandlerTypes';

export function useMedicationHandlerState(
  medications: MedicationHandlersDeps['medications'],
  selectDoseMode: MedicationHandlersDeps['selectDoseMode'],
  globalAutoDeductEnabled: boolean
): MedicationHandlerState {
  const restoreInFlightRef = useRef<Set<string>>(new Set());
  const refillUndoInFlightRef = useRef<Set<string>>(new Set());
  const medicationsRef = useRef<Medication[]>(medications);
  const selectDoseModeRef = useRef(selectDoseMode);
  const globalAutoDeductEnabledRef = useRef(globalAutoDeductEnabled);

  medicationsRef.current = medications;
  selectDoseModeRef.current = selectDoseMode;
  globalAutoDeductEnabledRef.current = globalAutoDeductEnabled;

  return {
    medicationsRef,
    selectDoseModeRef,
    globalAutoDeductEnabledRef,
    restoreInFlightRef,
    refillUndoInFlightRef,
  };
}
