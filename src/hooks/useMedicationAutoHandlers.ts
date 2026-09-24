import { persist } from '../utils/storage';
import { STORAGE_ERRORS } from '../constants/uiStrings';
import { STORAGE_AUTO_DEDUCT_PROMPTED_KEY } from '../constants/storageKeys';
import { playSuccessChime } from '../utils/sound';
import {
  runGatedAutoDeductToggle,
  runGatedGlobalAutoDeductToggle,
} from '../utils/manualStockMutation';
import type { MedicationHandlerState, MedicationHandlersDeps } from './medicationHandlerTypes';

export function useMedicationAutoHandlers(deps: MedicationHandlersDeps, state: MedicationHandlerState) {
  const {
    soundEnabled,
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
    setIsAutoDeductPromptOpen,
    setIsFirstRun,
    showToast,
  } = deps;
  const { medicationsRef, globalAutoDeductEnabledRef } = state;

  const handleToggleAutoDeduct = (medicationId: string) => {
    void (async () => {
      const result = await runGatedAutoDeductToggle({
        medicationId,
        globalAutoDeductEnabled: globalAutoDeductEnabledRef.current,
      });
      if (result.outcome !== 'applied') {
        if (result.outcome !== 'persist_failed') {
          setMedications(result.medications);
          medicationsRef.current = result.medications;
          setLogs(result.logs);
        }
        if (result.outcome === 'native_invalidation_failed') {
          showToast('تعذر تأمين إلغاء الجدولة الأصلية للجرعات — لم يتم تغيير الإعداد. حاول مرة أخرى.');
        } else if (result.outcome === 'native_list_failed') {
          showToast('تعذر قراءة حالة الخصم الأصلية — لم يتم تغيير الإعداد. حاول مرة أخرى.');
        } else if (result.outcome === 'missing_med') {
          showToast('لم يتم العثور على الدواء.');
        } else if (result.outcome === 'persist_failed') {
          showToast(STORAGE_ERRORS.generic);
        }
        return;
      }
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
      const name = result.medicationName ?? medicationId;
      showToast(
        result.newState
          ? `تم تفعيل الخصم التلقائي لـ "${name}"`
          : `تم إيقاف الخصم التلقائي مؤقتاً لـ "${name}"`
      );
      if (soundEnabled) playSuccessChime();
    })();
  };

  const handleToggleGlobalAutoDeduct = () => {
    const previous = globalAutoDeductEnabledRef.current;
    const next = !previous;
    globalAutoDeductEnabledRef.current = next;
    void (async () => {
      const result = await runGatedGlobalAutoDeductToggle({ enable: next });
      if (result.outcome !== 'applied') {
        globalAutoDeductEnabledRef.current = previous;
        if (result.outcome !== 'persist_failed') {
          setMedications(result.medications);
          medicationsRef.current = result.medications;
          setLogs(result.logs);
        }
        if (result.outcome === 'native_invalidation_failed') {
          showToast('تعذر تأمين إلغاء الجدولة الأصلية للجرعات — لم يتم تغيير الإعداد. حاول مرة أخرى.');
        } else if (result.outcome === 'native_list_failed') {
          showToast('تعذر قراءة حالة الخصم الأصلية — لم يتم تغيير الإعداد. حاول مرة أخرى.');
        } else if (result.outcome === 'persist_failed') {
          showToast(STORAGE_ERRORS.generic);
        }
        return;
      }
      globalAutoDeductEnabledRef.current = result.enable;
      setGlobalAutoDeductEnabled(result.enable);
      setMedications(result.medications);
      setLogs(result.logs);
      if (!result.enable) {
        showToast('تم إيقاف الخصم التلقائي لجميع الأدوية ⏸️');
      } else {
        showToast('تم تفعيل الخصم التلقائي لجميع الأدوية ⚡');
      }
      if (soundEnabled) playSuccessChime();
    })();
  };

  const handleConfirmAutoDeductPrompt = (enable: boolean) => {
    void (async () => {
      const result = await runGatedGlobalAutoDeductToggle({ enable });
      if (result.outcome !== 'applied') {
        setIsAutoDeductPromptOpen(true);
        return;
      }
      persist(STORAGE_AUTO_DEDUCT_PROMPTED_KEY, 'true', { json: false });
      setGlobalAutoDeductEnabled(result.enable);
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
      setIsAutoDeductPromptOpen(false);
      setIsFirstRun(false);
      if (soundEnabled) playSuccessChime();
      showToast(
        enable
          ? 'تم تفعيل الخصم التلقائي لمخزون الأدوية ⚡'
          : 'تم إيقاف الخصم التلقائي ⏸️ (المخزون ثابت حتى تسجل الجرعة يدوياً)'
      );
    })();
  };

  return { handleToggleAutoDeduct, handleToggleGlobalAutoDeduct, handleConfirmAutoDeductPrompt };
}
