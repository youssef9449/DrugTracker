import { useCallback } from 'react';
import type { Medication } from '../types';
import { runGatedManualConsume, shouldDismissAlarmAfterManualTake } from '../utils/manualStockMutation';
import { playSuccessChime } from '../utils/sound';
import { TOAST_MESSAGES, STORAGE_ERRORS } from '../constants/uiStrings';
import { DEFAULT_SNOOZE_MINUTES } from '../utils/time';
import { cancelNotification } from '../utils/notificationRuntime';
import { runAsyncCommand } from '../utils/async/runAsyncCommand';
import type { MedicationHandlerState, MedicationHandlersDeps } from './medicationHandlerTypes';

export function useMedicationAlarmHandlers(deps: MedicationHandlersDeps, state: MedicationHandlerState) {
  const { soundEnabled, setMedications, setLogs, showToast, dismissAlarm, snoozeAlarm } = deps;
  const { medicationsRef } = state;

  const runAlarmTake = useCallback(async (
    medicationId: string,
    doseId: string | undefined,
    fallbackMed?: Medication
  ) => {
    const result = await runGatedManualConsume({
      medicationId,
      doseId,
      source: 'alarm',
    });
    const displayName = result.medicationName ?? fallbackMed?.name ?? '';
    const displayUnit = result.unit ?? fallbackMed?.unit ?? '';
    if (result.outcome !== 'persist_failed') {
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
    }
    if (result.outcome === 'applied' && result.log) {
      void cancelNotification('dose-reminder', medicationId + '::' + (doseId ?? ''));
      if (displayName) {
        showToast(TOAST_MESSAGES.doseTaken(displayName, result.doseAmount, displayUnit));
      }
      if (soundEnabled) playSuccessChime();
    } else if (result.outcome === 'already_consumed' && displayName) {
      showToast(TOAST_MESSAGES.doseAlreadyTaken(displayName));
    } else if (result.outcome === 'persist_failed') {
      showToast(STORAGE_ERRORS.generic);
    } else if (result.outcome === 'rejected') {
      showToast('لم يتم تسجيل الجرعة: تعذر التحقق من حالة الجرعة بشكل آمن — لم يتم أي خصم. حاول مرة أخرى.');
    } else if (result.outcome === 'missing_med' || result.outcome === 'missing_dose_id') {
      showToast('لم يتم تسجيل الجرعة: تعذر تحديد الدواء أو الجرعة المطلوبة.');
    }
    if (shouldDismissAlarmAfterManualTake(result.outcome)) {
      const dismissed = dismissAlarm();
      if (!dismissed) showToast(STORAGE_ERRORS.generic);
    }
  }, [dismissAlarm, soundEnabled, setMedications, setLogs, showToast]);

  const handleTakeDoseFromAlarm = useCallback((med: Medication, doseId?: string) => {
    runAsyncCommand(
      'dose-reminder.take',
      async () => {
        await runAlarmTake(med.id, doseId, med);
      },
      () => {
        showToast(STORAGE_ERRORS.generic);
      }
    );
  }, [runAlarmTake, showToast]);

  const handleTakeDoseFromAlarmById = useCallback((medicationId: string, doseId?: string) => {
    runAsyncCommand(
      'dose-reminder.take-by-id',
      async () => {
        await runAlarmTake(medicationId, doseId);
      },
      () => {
        showToast(STORAGE_ERRORS.generic);
      }
    );
  }, [runAlarmTake, showToast]);

  const handleSnoozeFromAlarm = (med: Medication) => {
    snoozeAlarm(DEFAULT_SNOOZE_MINUTES);
    showToast(TOAST_MESSAGES.doseSnoozed(med.name));
  };

  return { handleTakeDoseFromAlarm, handleTakeDoseFromAlarmById, handleSnoozeFromAlarm };
}
