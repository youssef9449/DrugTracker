import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { cleanupNativeListeners } from '../native';
import type { Medication } from '../types';

interface UseAppBackOverlaysOptions {
  registerBackOverlay: (id: string, close: () => void, priority?: number) => () => void;
  alarmingMedication: Medication | null;
  dismissAlarm: () => boolean;
  selectDoseMed: Medication | null;
  setSelectDoseMed: Dispatch<SetStateAction<Medication | null>>;
  setSelectDoseMode: Dispatch<SetStateAction<'take' | 'restore' | 'manage'>>;
  historyMedication: Medication | null;
  setHistoryMedication: Dispatch<SetStateAction<Medication | null>>;
  isAutoDeductPromptOpen: boolean;
  handleConfirmAutoDeductPrompt: (enable: boolean) => void;
  isAddModalOpen: boolean;
  setIsAddModalOpen: Dispatch<SetStateAction<boolean>>;
  setEditingMedication: Dispatch<SetStateAction<Medication | null>>;
  refillMedication: Medication | null;
  setRefillMedication: Dispatch<SetStateAction<Medication | null>>;
  isSettingsModalOpen: boolean;
  setIsSettingsModalOpen: Dispatch<SetStateAction<boolean>>;
}

export function useAppBackOverlays(options: UseAppBackOverlaysOptions) {
  const {
    registerBackOverlay, alarmingMedication, dismissAlarm, selectDoseMed, setSelectDoseMed,
    setSelectDoseMode, historyMedication, setHistoryMedication, isAutoDeductPromptOpen,
    handleConfirmAutoDeductPrompt, isAddModalOpen, setIsAddModalOpen, setEditingMedication,
    refillMedication, setRefillMedication, isSettingsModalOpen, setIsSettingsModalOpen,
  } = options;
  const confirmAutoDeductRef = useRef(handleConfirmAutoDeductPrompt);

  useEffect(() => {
    confirmAutoDeductRef.current = handleConfirmAutoDeductPrompt;
  }, [handleConfirmAutoDeductPrompt]);

  useEffect(() => {
    const registrations = [
      alarmingMedication
        ? registerBackOverlay('dose-alarm', dismissAlarm, 100)
        : undefined,
      selectDoseMed
        ? registerBackOverlay('select-dose', () => {
            setSelectDoseMed(null);
            setSelectDoseMode('take');
          }, 90)
        : undefined,
      historyMedication
        ? registerBackOverlay('medication-history', () => setHistoryMedication(null), 80)
        : undefined,
      isAutoDeductPromptOpen
        ? registerBackOverlay('auto-deduct-prompt', () => {
            confirmAutoDeductRef.current(false);
          }, 70)
        : undefined,
      isAddModalOpen
        ? registerBackOverlay('add-medication', () => {
            setIsAddModalOpen(false);
            setEditingMedication(null);
          }, 60)
        : undefined,
      refillMedication
        ? registerBackOverlay('refill', () => setRefillMedication(null), 50)
        : undefined,
      isSettingsModalOpen
        ? registerBackOverlay('settings', () => setIsSettingsModalOpen(false), 40)
        : undefined,
    ];
    return () => registrations.forEach((unregister) => unregister?.());
  }, [
    alarmingMedication, dismissAlarm, selectDoseMed, historyMedication, isAutoDeductPromptOpen,
    isAddModalOpen, refillMedication, isSettingsModalOpen, registerBackOverlay,
    setSelectDoseMed, setSelectDoseMode, setHistoryMedication, setIsAddModalOpen,
    setEditingMedication, setRefillMedication, setIsSettingsModalOpen,
  ]);

  useEffect(() => {
    return () => {
      cleanupNativeListeners()?.catch?.(() => {});
    };
  }, []);
}
