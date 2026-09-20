import {
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { flushSync } from 'react-dom';
import type { Medication, ConsumptionLog } from '../types';
import {
  getTodayDateString,
} from '../utils/dateCalculations';
import {
  runGatedManualConsume,
  runGatedManualRestore,
  runGatedAddMedication,
  runGatedRefill,
  runGatedUndoRefill,
  runGatedAutoDeductToggle,
  runGatedGlobalAutoDeductToggle,
  runGatedMedicationUpdate,
  runGatedDeleteMedication,
  shouldDismissAlarmAfterManualTake,
  type GatedManualRestoreResult,
} from '../utils/manualStockMutation';
import { generateId } from '../utils/id';
import { playSuccessChime } from '../utils/sound';
import { persist } from '../utils/storage';
import { TOAST_MESSAGES, STORAGE_ERRORS } from '../constants/uiStrings';
import { STORAGE_AUTO_DEDUCT_PROMPTED_KEY } from '../constants/storageKeys';
import {
  requestNotificationPermission,
  getNotificationPermission,
  ensureCriticalStockPermissions,
} from '../utils/notifications';
import { DEFAULT_SNOOZE_MINUTES } from '../utils/time';

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
  dismissAlarm: () => void;
  /** Matches useDoseReminders.snoozeAlarm(minutes?). */
  snoozeAlarm: (minutes?: number) => void;
}

/**
 * Medication mutation handlers extracted from App.tsx.
 * Preserves guards, in-flight refs, toasts, and state update ordering.
 */
export function useMedicationHandlers(deps: MedicationHandlersDeps) {
  const {
    medications,
    soundEnabled,
    globalAutoDeductEnabled,
    criticalStockAlertsEnabled,
    selectDoseMode,
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
    setIsAutoDeductPromptOpen,
    setIsFirstRun,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    setSelectDoseMed,
    setSelectDoseMode,
    setEditingMedication,
    showToast,
    dismissAlarm,
    snoozeAlarm,
  } = deps;

  const restoreInFlightRef = useRef<Set<string>>(new Set());
  const refillUndoInFlightRef = useRef<Set<string>>(new Set());
  // Always-current snapshots so card/modal handlers never open SelectDoseModal
  // with a pre-Take medication or a stale selectDoseMode after decomposition.
  const medicationsRef = useRef(medications);
  medicationsRef.current = medications;
  const selectDoseModeRef = useRef(selectDoseMode);
  selectDoseModeRef.current = selectDoseMode;
  const globalAutoDeductEnabledRef = useRef(globalAutoDeductEnabled);
  globalAutoDeductEnabledRef.current = globalAutoDeductEnabled;

  const handleRestoreDose = async (
    medicationId: string,
    reason: string,
    doseId?: string
  ): Promise<{ medication: Medication | null; result: GatedManualRestoreResult | null }> => {
    // Outside the gate: only request inputs + double-click guard.
    // restoreKey is derived from inputs alone (no React medication/logs).
    // Every business decision (missing med/dose, auto_deduct_off,
    // already_restored, amount, active deduction) is made inside
    // runGatedManualRestore against fresh durable state.
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
      // Every non-persist-failure result carries a durable snapshot. Keep React
      // aligned even when Restore itself becomes a no-op after exact recovery.
      if (result.outcome !== 'persist_failed') {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
      }

      // Map durable outcomes to UI messages; never claim success on failure.
      if (result.outcome === 'already_restored' || result.reason === 'already_restored') {
        if (displayName) showToast(TOAST_MESSAGES.doseAlreadyRestored(displayName));
      } else if (result.reason === 'auto_deduct_off') {
        if (displayName) showToast(TOAST_MESSAGES.autoDeductOff(displayName));
      } else if (result.reason === 'missing_dose_id') {
        showToast('اختر الجرعة المراد استرجاعها');
      } else if (result.outcome === 'persist_failed') {
        showToast(STORAGE_ERRORS.generic);
      }
      // missing_med / other rejected → no success state
      return { medication: null, result };
    } finally {
      restoreInFlightRef.current.delete(restoreKey);
    }
  };

  const handleConfirmRefill = (medicationId: string, addedPills: number) => {
    // Input validation only — no React medication lookup. Settlement, stock,
    // and log creation all happen inside runGatedRefill on fresh durable state.
    if (!(addedPills > 0)) return;
    // A new refill creates a fresh undoable log entry, so clear the
    // dedup guard that blocked rapid double-undo of the previous refill.
    refillUndoInFlightRef.current.delete(medicationId);
    void (async () => {
      const result = await runGatedRefill({
        medicationId,
        addedPills,
      });
      if (result.outcome !== 'persist_failed') {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
      }
      if (result.outcome === 'applied' && result.log) {
        if (soundEnabled) playSuccessChime();
      }
    })();
  };

  const handleUndoRefill = (medicationId: string) => {
    // In-flight guard only. Medication existence, refill selection, and
    // stock math are decided exclusively inside runGatedUndoRefill against
    // fresh durable medications + logs (not React snapshot).
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
        }
      } finally {
        refillUndoInFlightRef.current.delete(medicationId);
      }
    })();
  };

  const handleToggleAutoDeduct = (medicationId: string) => {
    // Phase 4: durable gate — settlement from React snapshot is forbidden.
    // Exact FIRED reconciliation runs inside the gate before the current toggle mutation.
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
        // Audit fix: fail-closed toggle outcomes must not be silent — the
        // durable state is unchanged, so tell the user nothing happened.
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
    // Eagerly update the request ref so consecutive clicks before React
    // renders alternate OFF/ON instead of reading the same stale closure.
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
        // Audit fix: fail-closed toggle outcomes must not be silent — the
        // durable state is unchanged, so tell the user nothing happened.
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
      // Global bulk-sets every existing medication + remains the new-med default.
      if (!result.enable) {
        showToast('تم إيقاف الخصم التلقائي لجميع الأدوية ⏸️');
      } else {
        showToast('تم تفعيل الخصم التلقائي لجميع الأدوية ⚡');
      }
      if (soundEnabled) playSuccessChime();
    })();
  };

  const handleConfirmAutoDeductPrompt = (enable: boolean) => {
    // First-run preference uses the same durable global mutation gate as every
    // later global toggle. Do not create a second durable writer for the
    // global master switch.
    void (async () => {
      const result = await runGatedGlobalAutoDeductToggle({ enable });
      if (result.outcome !== 'applied') {
        // Keep the prompt retryable. In particular, native/read/persistence
        // failures must not record the prompt as completed before the durable
        // policy change actually lands.
        setIsAutoDeductPromptOpen(true);
        return;
      }

      persist(STORAGE_AUTO_DEDUCT_PROMPTED_KEY, 'true', { json: false });
      setGlobalAutoDeductEnabled(result.enable);
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
      setIsAutoDeductPromptOpen(false);
      // Only after durable policy commits: unlock scheduler hooks for this session.
      setIsFirstRun(false);
      if (soundEnabled) playSuccessChime();
      showToast(
        enable
          ? 'تم تفعيل الخصم التلقائي لمخزون الأدوية ⚡'
          : 'تم إيقاف الخصم التلقائي ⏸️ (المخزون ثابت حتى تسجل الجرعة يدوياً)'
      );
    })();
  };



  const handleSaveMedication = (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => {
    if (editId) {
      // Phase 4: durable gate — stock/settlement from fresh durable med, not React.
      void (async () => {
        const result = await runGatedMedicationUpdate({
          editId,
          medData,
          globalAutoDeductEnabled: globalAutoDeductEnabledRef.current,
        });
        if (result.outcome !== 'applied') {
          if (result.outcome !== 'persist_failed') {
            setMedications(result.medications);
            medicationsRef.current = result.medications;
            setLogs(result.logs);
          }
          return;
        }
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
        showToast(
          medData.reminderEnabled
            ? `تم حفظ "${medData.name}" مع تذكير يومي الساعة ${medData.reminderTime}`
            : `تم تعديل بيانات "${medData.name}" بنجاح`
        );
        if (soundEnabled) playSuccessChime();
        setEditingMedication(null);
      })();
      return;
    }
    const newMed: Medication = {
      ...medData,
      id: 'med-' + Date.now(),
      createdAt: new Date().toISOString(),
      autoDeductEnabled: globalAutoDeductEnabledRef.current,
    };
    void (async () => {
      const result = await runGatedAddMedication({ medication: newMed });
      if (result.outcome !== 'applied') return;
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
      showToast(
        newMed.reminderEnabled
          ? `تمت إضافة "${newMed.name}" مع تنبيه الساعة ${newMed.reminderTime}`
          : `تمت إضافة "${newMed.name}"، وسيحسب استهلاكه تلقائياً`
      );
      if (soundEnabled) playSuccessChime();
      setEditingMedication(null);
    })();
  };


  const handleDeleteMedication = (id: string) => {
    void (async () => {
      const result = await runGatedDeleteMedication({ medicationId: id });
      if (result.outcome !== 'persist_failed') {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
      }
      if (result.outcome === 'applied') {
        const name = result.medicationName ?? id;
        showToast(`تم حذف "${name}" من القائمة`);
      }
    })();
  };


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
      if (displayName) {
        showToast(TOAST_MESSAGES.doseTaken(displayName, result.doseAmount, displayUnit));
      }
      if (soundEnabled) playSuccessChime();
    } else if (result.outcome === 'already_consumed' && displayName) {
      showToast(TOAST_MESSAGES.doseAlreadyTaken(displayName));
    } else if (result.outcome === 'persist_failed') {
      // Covers native snapshot failures and Exact-durability barriers on the
      // notification action path; never leave a failed action silent.
      showToast(STORAGE_ERRORS.generic);
    } else if (result.outcome === 'rejected') {
      // Audit fix: fail-closed rejections on the alarm path (e.g.
      // native_snapshot_failed) must not be silent either. The alarm stays
      // open so the user can retry once the underlying state is readable.
      showToast('لم يتم تسجيل الجرعة: تعذر التحقق من حالة الجرعة بشكل آمن — لم يتم أي خصم. حاول مرة أخرى.');
    } else if (result.outcome === 'missing_med' || result.outcome === 'missing_dose_id') {
      showToast('لم يتم تسجيل الجرعة: تعذر تحديد الدواء أو الجرعة المطلوبة.');
    }
    if (shouldDismissAlarmAfterManualTake(result.outcome)) {
      dismissAlarm();
    }
  }, [dismissAlarm, soundEnabled, setMedications, setLogs, showToast]);

  const handleTakeDoseFromAlarm = useCallback((med: Medication, doseId?: string) => {
    void runAlarmTake(med.id, doseId, med);
  }, [runAlarmTake]);

  /** Notification action entry point: identity only, never a React snapshot. */
  const handleTakeDoseFromAlarmById = useCallback((medicationId: string, doseId?: string) => {
    void runAlarmTake(medicationId, doseId);
  }, [runAlarmTake]);


  const handleSnoozeFromAlarm = (med: Medication) => {
    snoozeAlarm(DEFAULT_SNOOZE_MINUTES);
    showToast(TOAST_MESSAGES.doseSnoozed(med.name));
  };

  // Open the Android exact-alarm settings screen so the user can grant
  // SCHEDULE_EXACT_ALARM. On web this is a no-op. After the user returns
  // to the app, the appStateChange listener re-checks the permission
  // and updates exactAlarmEnabled → the scheduler reschedules.

  const handleConsumeDose = (medicationId: string, doseId?: string) => {
    // Outside the gate: only request inputs. All business decisions
    // (med existence, schedule, single/multi resolution, already_consumed,
    // amount) are made inside runGatedManualConsume against fresh durable
    // state. A stale/empty React snapshot must never block or redirect Take.
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
      if (
        result.outcome === 'already_consumed' ||
        result.reason === 'already_consumed'
      ) {
        if (displayName) showToast(TOAST_MESSAGES.doseAlreadyTaken(displayName));
        return;
      }
      // Multi-dose without doseId: open SelectDoseModal using fresh durable med.
      if (result.outcome === 'missing_dose_id') {
        const freshMed =
          result.medications.find((m) => m.id === medicationId) ?? null;
        if (freshMed) {
          flushSync(() => {
            setSelectDoseMode('manage');
          });
          setSelectDoseMed(freshMed);
        }
        return;
      }
      if (result.outcome === 'persist_failed') {
        showToast(STORAGE_ERRORS.generic);
        return;
      }
      // missing_med / rejected / other — no success or already-taken toast.
    })();
  };

  /**
   * Card toggle restore.
   * Multi-dose without doseId → SelectDoseModal (restore mode), same UX as Take.
   * Explicit doseId (including single-slot schedule) → direct restoreDose path.
   * No-schedule medications are not a supported current single-dose runtime mode.
   *
   * Mode is committed with flushSync before selectDoseMed so the first
   * SelectDoseModal render after open always sees mode='restore'. Otherwise
   * a take-mode first paint marks manually-consumed doses disabled
   * (isSelectable = !completed).
   */
  const handleCardRestoreDose = (medicationId: string, doseId?: string) => {
    // Request-only wrapper: no React medication lookup, no multi-dose
    // detection, no schedule lookup, no restore eligibility decision.
    // All business decisions happen inside the durable gate via
    // runGatedManualRestore against fresh durable state.
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
        // The durable gate resolved the medication and determined the
        // doseId is required. Open the SelectDoseModal using the FRESH
        // durable medication from result.medications — NOT
        // medicationsRef.current (which may be stale or empty).
        const durableMed = durableResult.medications.find(
          (m) => m.id === medicationId
        );
        if (durableMed) {
          const isMulti =
            Array.isArray(durableMed.doseSchedule) &&
            durableMed.doseSchedule.length > 1;
          if (isMulti) {
            flushSync(() => {
              setSelectDoseMode('manage');
            });
            setSelectDoseMed(durableMed);
          }
        }
      }
    })();
  };

  const handleSelectDoseFromModal = (medicationId: string, doseId: string) => {
    // Prefer ref so selection uses the mode that opened the modal, not a
    // stale closure if the callback identity lagged one render.
    // mode='restore' → restore; mode='take' | 'manage' → consume (manage
    // restore goes through SelectDoseModal.onRestore → handleCardRestoreDose).
    if (selectDoseModeRef.current === 'restore') {
      handleCardRestoreDose(medicationId, doseId);
    } else {
      handleConsumeDose(medicationId, doseId);
    }
  };

  // #79: extracted from two byte-identical inline handlers passed to
  // AppHeader and AppSettingsModal. useCallback so both props get the
  // same stable reference.
  // Critical-stock alerts are independent of dose-reminder preference.
  // Turning ON only requires OS notification permission; it must NOT
  // flip notificationsEnabled (dose-time reminders).
  const handleToggleCriticalStockAlerts = useCallback(async () => {
    const next = !criticalStockAlertsEnabled;
    if (!next) {
      // Turning OFF — always allowed regardless of current permissions.
      setCriticalStockAlertsEnabled(false);
      showToast(TOAST_MESSAGES.criticalAlertsOff);
      return;
    }

    // Turning ON — shared permission contract: display + (Android) exact-alarm.
    // Do NOT set or persist enabled while required permission is still missing.
    // Never mutate notificationsEnabled here (dose reminders stay independent).
    let allowed = false;
    try {
      allowed = await ensureCriticalStockPermissions();
    } catch (err) {
      console.warn('[App] Critical stock permission error (toggle):', err);
    }
    if (!allowed) {
      showToast(TOAST_MESSAGES.notificationsPermissionDenied);
      return;
    }

    setCriticalStockAlertsEnabled(true);
    if (soundEnabled) playSuccessChime();
    showToast(TOAST_MESSAGES.criticalAlertsOn);
  }, [criticalStockAlertsEnabled, soundEnabled, showToast, setCriticalStockAlertsEnabled]);

  // #88: Single memoized medications-with-status array. Previously
  // calculateMedicationStatus(med) was recomputed in 4 separate memos
  // (filteredMedications, alertsCount, sufficientCount, totalStockByUnit)
  // + inside LowStockBanner (3x per med). Now all derive from this one.

  return {
    handleRestoreDose,
    handleConfirmRefill,
    handleUndoRefill,
    handleToggleAutoDeduct,
    handleToggleGlobalAutoDeduct,
    handleConfirmAutoDeductPrompt,
    handleSaveMedication,
    handleDeleteMedication,
    handleTakeDoseFromAlarm,
    handleTakeDoseFromAlarmById,
    handleSnoozeFromAlarm,
    handleConsumeDose,
    handleCardRestoreDose,
    handleSelectDoseFromModal,
    handleToggleCriticalStockAlerts,
  };
}
