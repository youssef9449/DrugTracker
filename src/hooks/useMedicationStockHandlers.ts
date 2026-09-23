import { flushSync } from 'react-dom';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  runGatedManualConsume,
  runGatedManualRestore,
  runGatedRefill,
  runGatedUndoRefill,
  type GatedManualRestoreResult,
} from '../utils/manualStockMutation';
import { generateId } from '../utils/id';
import { playSuccessChime } from '../utils/sound';
import { TOAST_MESSAGES, STORAGE_ERRORS } from '../constants/uiStrings';
import type { MedicationHandlerState, MedicationHandlersDeps } from './medicationHandlerTypes';

export function useMedicationStockHandlers(
  deps: MedicationHandlersDeps,
  state: MedicationHandlerState
) {
  const {
    soundEnabled,
    selectDoseMode,
    setMedications,
    setLogs,
    setSelectDoseMed,
    setSelectDoseMode,
    showToast,
  } = deps;
  const {
    medicationsRef,
    selectDoseModeRef,
    restoreInFlightRef,
    refillUndoInFlightRef,
  } = state;

  const handleRestoreDose = async (
    medicationId: string,
    reason: string,
    doseId?: string
  ): Promise<{ medication: Medication | null; result: GatedManualRestoreResult | null }> => {
    const today = getTodayDateString();
    const restoreKey =
      doseId != null && doseId !== ''
        ? `${medicationId}:${doseId}:${today}`
        : `${medicationId}:${today}`;
    if (restoreInFlightRef.current.has(restoreKey)) {
      return { medication: null, result: null };
    }
    restoreInFlightRef.current.add(restoreKey);
    try {
      const result = await runGatedManualRestore({
        medicationId,
        doseId,
        makeLogId: () => generateId('restore'),
      });
      const displayName = result.medicationName ?? '';
      const displayUnit = result.unit ?? '';
      if (result.outcome === 'applied' && result.log) {
        const logsWithReason = result.logs.map((l, i) =>
          i === 0
            ? {
                ...l,
                description: `استرجاع جرعة (${reason}) (+${result.restoredAmount} ${displayUnit})`,
              }
            : l
        );
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(logsWithReason);
        if (soundEnabled) playSuccessChime();
        if (displayName) showToast(`تم استرجاع الجرعة — ${displayName}`);
        return {
          medication: result.medications.find((m) => m.id === medicationId) ?? null,
          result,
        };
      }
      if (result.outcome !== 'persist_failed') {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
      }
      if (result.outcome === 'already_restored' || result.reason === 'already_restored') {
        if (displayName) showToast(TOAST_MESSAGES.doseAlreadyRestored(displayName));
      } else if (result.reason === 'auto_deduct_off') {
        if (displayName) showToast(TOAST_MESSAGES.autoDeductOff(displayName));
      } else if (result.reason === 'missing_dose_id') {
        showToast('اختر الجرعة المراد استرجاعها');
      } else if (result.outcome === 'persist_failed') {
        showToast(STORAGE_ERRORS.generic);
      }
      return { medication: null, result };
    } finally {
      restoreInFlightRef.current.delete(restoreKey);
    }
  };

  const handleConfirmRefill = async (medicationId: string, addedPills: number): Promise<boolean> => {
    if (!(addedPills > 0)) return false;
    refillUndoInFlightRef.current.delete(medicationId);
    const result = await runGatedRefill({ medicationId, addedPills });
    if (result.outcome !== 'persist_failed') {
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
    }
    if (result.outcome === 'applied' && result.log) {
      if (soundEnabled) playSuccessChime();
      return true;
    }
    showToast(STORAGE_ERRORS.generic);
    return false;
  };

  const handleUndoRefill = (medicationId: string) => {
    if (refillUndoInFlightRef.current.has(medicationId)) return;
    refillUndoInFlightRef.current.add(medicationId);
    void (async () => {
      try {
        const result = await runGatedUndoRefill({ medicationId });
        if (result.outcome !== 'persist_failed') {
          setMedications(result.medications);
          medicationsRef.current = result.medications;
          setLogs(result.logs);
        }
        if (result.outcome === 'applied' && result.log) {
          const name = result.medicationName ?? result.log.medicationName ?? '';
          if (name) showToast(TOAST_MESSAGES.refillUndone(name));
          if (soundEnabled) playSuccessChime();
        } else if (result.outcome === 'persist_failed') {
          showToast(STORAGE_ERRORS.generic);
        }
      } finally {
        refillUndoInFlightRef.current.delete(medicationId);
      }
    })();
  };

  const handleConsumeDose = (medicationId: string, doseId?: string) => {
    void (async () => {
      const result = await runGatedManualConsume({
        medicationId,
        doseId,
        source: 'manual',
      });
      const displayName = result.medicationName ?? '';
      const displayUnit = result.unit ?? '';
      if (result.outcome !== 'persist_failed') {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
      }
      if (result.outcome === 'applied' && result.log) {
        const updatedMed = result.medications.find((m) => m.id === medicationId);
        if (selectDoseModeRef.current === 'manage' && updatedMed) {
          setSelectDoseMed(updatedMed);
        } else {
          setSelectDoseMed(null);
          setSelectDoseMode('take');
        }
        if (displayName) {
          showToast(TOAST_MESSAGES.doseTaken(displayName, result.doseAmount, displayUnit));
        }
        if (soundEnabled) playSuccessChime();
        return;
      }
      if (result.outcome === 'already_consumed' || result.reason === 'already_consumed') {
        if (displayName) showToast(TOAST_MESSAGES.doseAlreadyTaken(displayName));
        return;
      }
      if (result.outcome === 'missing_dose_id') {
        const freshMed = result.medications.find((m) => m.id === medicationId) ?? null;
        if (freshMed) {
          flushSync(() => setSelectDoseMode('manage'));
          setSelectDoseMed(freshMed);
        }
        return;
      }
      if (result.outcome === 'persist_failed') {
        showToast(STORAGE_ERRORS.generic);
      }
    })();
  };

  const handleCardRestoreDose = (medicationId: string, doseId?: string) => {
    void (async () => {
      const { medication: updated, result: durableResult } = await handleRestoreDose(
        medicationId,
        'card',
        doseId
      );
      if (updated) {
        if (selectDoseModeRef.current === 'manage') {
          setSelectDoseMed(updated);
        } else {
          setSelectDoseMed(null);
          setSelectDoseMode('take');
        }
      } else if (
        durableResult &&
        durableResult.reason === 'missing_dose_id' &&
        !doseId
      ) {
        const durableMed = durableResult.medications.find((m) => m.id === medicationId);
        if (durableMed) {
          const isMulti =
            Array.isArray(durableMed.doseSchedule) &&
            durableMed.doseSchedule.length > 1;
          if (isMulti) {
            flushSync(() => setSelectDoseMode('manage'));
            setSelectDoseMed(durableMed);
          }
        }
      }
    })();
  };

  const handleSelectDoseFromModal = (medicationId: string, doseId: string) => {
    if (selectDoseModeRef.current === 'restore') {
      handleCardRestoreDose(medicationId, doseId);
    } else {
      handleConsumeDose(medicationId, doseId);
    }
  };

  return {
    handleRestoreDose,
    handleConfirmRefill,
    handleUndoRefill,
    handleConsumeDose,
    handleCardRestoreDose,
    handleSelectDoseFromModal,
  };
}
