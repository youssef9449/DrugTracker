import { useEffect, useRef } from 'react';
import { cleanupNativeListeners } from '../native';
import type { Medication } from '../types';

interface UseAppBackOverlaysOptions {
  registerBackOverlay: (id: string, close: () => void, priority?: number) => () => void;
  alarmingMedication: Medication | null;
  dismissAlarm: () => boolean;
  selectDoseMed: Medication | null;
  setSelectDoseMed: React.Dispatch<React.SetStateAction<Medication | null>>;
  setSelectDoseMode: React.Dispatch<React.SetStateAction<'take' | 'restore' | 'manage'>>;
  historyMedication: Medication | null;
  setHistoryMedication: React.Dispatch<React.SetStateAction<Medication | null>>;
  isAutoDeductPromptOpen: boolean;
  handleConfirmAutoDeductPrompt: (enable: boolean) => void;
  isAddModalOpen: boolean;
  setIsAddModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingMedication: React.Dispatch<React.SetStateAction<Medication | null>>;
  refillMedication: Medication | null;
  setRefillMedication: React.Dispatch<React.SetStateAction<Medication | null>>;
  isSettingsModalOpen: boolean;
  setIsSettingsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
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
