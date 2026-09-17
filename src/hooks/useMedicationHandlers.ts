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
  settleDoseChange,
  settleAutoDeductToggle,
} from '../utils/dateCalculations';
import { resolveRestoreDoseAmount } from '../utils/medActions';
import {
  runGatedManualConsume,
  runGatedManualRestore,
  runGatedRefill,
  runGatedUndoRefill,
  shouldDismissAlarmAfterManualTake,
} from '../utils/manualStockMutation';
import { generateId } from '../utils/id';
import { playSuccessChime } from '../utils/sound';
import { persist } from '../utils/storage';
import { pruneDoseConsumption } from '../utils/pruneDoseConsumption';
import { TOAST_MESSAGES, STORAGE_ERRORS } from '../constants/uiStrings';
import {
  STORAGE_AUTO_DEDUCT_PROMPTED_KEY,
  STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
} from '../constants/storageKeys';
import {
  requestNotificationPermission,
  getNotificationPermission,
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
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>;
  setCriticalStockAlertsEnabled: Dispatch<SetStateAction<boolean>>;
  setSelectDoseMed: Dispatch<SetStateAction<Medication | null>>;
  setSelectDoseMode: Dispatch<SetStateAction<'take' | 'restore' | 'manage'>>;
  setEditingMedication: Dispatch<SetStateAction<Medication | null>>;
  showToast: (message: string) => void;
  dismissAlarm: () => void;
  /** Matches useDoseReminders.snoozeAlarm(med, minutes?). */
  snoozeAlarm: (medication: Medication, minutes?: number) => void;
}

/**
 * Medication mutation handlers extracted from App.tsx.
 * Preserves guards, in-flight refs, toasts, and state update ordering.
 */
export function useMedicationHandlers(deps: MedicationHandlersDeps) {
  const {
    medications,
    logs,
    soundEnabled,
    globalAutoDeductEnabled,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    selectDoseMode,
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
    setIsAutoDeductPromptOpen,
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

  const handleRestoreDose = async (
    medicationId: string,
    reason: string,
    doseId?: string
  ): Promise<Medication | null> => {
    // UI-layer only: identity + in-flight guard. All business correctness
    // (auto_deduct_off, already_restored, consumed vs auto-only, future vs
    // elapsed, restore amount, active deduction) is decided exclusively
    // inside runGatedManualRestore() against fresh durable state.
    // A stale React snapshot must NEVER prevent a Restore that durable
    // state would accept.
    const med = medicationsRef.current.find((m) => m.id === medicationId);
    if (!med) return null;
    const today = getTodayDateString();

    // Resolve dose identity for UI / in-flight key only (not stock decisions).
    const preResolved = resolveRestoreDoseAmount(med, doseId);
    if (!preResolved.ok) {
      if (preResolved.reason === 'missing_dose_id') {
        showToast('اختر الجرعة المراد استرجاعها');
      }
      return null;
    }
    const resolvedDoseId = preResolved.doseId;
    const restoreKey = resolvedDoseId
      ? `${medicationId}:${resolvedDoseId}:${today}`
      : `${medicationId}:${today}`;

    if (restoreInFlightRef.current.has(restoreKey)) return null;
    restoreInFlightRef.current.add(restoreKey);

    try {
      const result = await runGatedManualRestore({
        medicationId,
        doseId,
        todayStr: today,
        makeLogId: () => generateId('restore'),
      });
      if (result.outcome === 'applied' && result.log) {
        const logsWithReason = result.logs.map((l, i) =>
          i === 0
            ? {
                ...l,
                description: `استرجاع جرعة (${reason}) (+${result.restoredAmount} ${med.unit})`,
              }
            : l
        );
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(logsWithReason);
        if (soundEnabled) playSuccessChime();
        return result.medications.find((m) => m.id === medicationId) ?? null;
      }
      // Map durable outcomes to UI messages; never claim success on failure.
      if (result.outcome === 'already_restored' || result.reason === 'already_restored') {
        showToast(TOAST_MESSAGES.doseAlreadyRestored(med.name));
      } else if (result.reason === 'auto_deduct_off') {
        showToast(TOAST_MESSAGES.autoDeductOff(med.name));
      } else if (result.reason === 'missing_dose_id') {
        showToast('اختر الجرعة المراد استرجاعها');
      }
      // persist_failed / missing_med / other rejected → no success state
      return null;
    } finally {
      restoreInFlightRef.current.delete(restoreKey);
    }
  };

  const handleConfirmRefill = (medicationId: string, addedPills: number) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med || addedPills <= 0) return;
    // A new refill creates a fresh undoable log entry, so clear the
    // dedup guard that blocked rapid double-undo of the previous refill.
    refillUndoInFlightRef.current.delete(medicationId);
    // Phase 4: route through the durable stock mutation gate so the refill
    // serializes with concurrent Take/Restore/Exact Auto reconciliation and
    // settles against FRESH durable state (not a potentially-stale React
    // snapshot). Behavior preserved: settleAndAdjust + refill log.
    void (async () => {
      const result = await runGatedRefill({
        medicationId,
        addedPills,
      });
      if (result.outcome === 'applied' && result.log) {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
        if (soundEnabled) playSuccessChime();
      }
    })();
  };

  const handleUndoRefill = (medicationId: string) => {
    if (refillUndoInFlightRef.current.has(medicationId)) return;
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    refillUndoInFlightRef.current.add(medicationId);

    // Clear the guard after the current event-loop tick. This blocks a
    // rapid double-click (same tick — the timeout hasn't fired yet) while
    // allowing a legitimate subsequent undo of the NEXT refill (after the
    // timeout fires and the state has updated). React's act() in tests
    // flushes state updates but NOT setTimeout (a macrotask), so the guard
    // stays set between synchronous fireEvent calls.
    setTimeout(() => {
      refillUndoInFlightRef.current.delete(medicationId);
    }, 0);

    // Phase 4: route through the durable stock mutation gate so the undo
    // serializes with concurrent Take/Restore/Exact Auto reconciliation.
    // Behavior preserved: reverseRefill (settleAndAdjust −amount), mark the
    // refill log reversedAt, prepend refill_undo log with relatedLogId.
    void (async () => {
      const result = await runGatedUndoRefill({ medicationId });
      if (result.outcome === 'applied' && result.log) {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
        showToast(TOAST_MESSAGES.refillUndone(med.name));
        if (soundEnabled) playSuccessChime();
      }
    })();
  };

  const handleToggleAutoDeduct = (medicationId: string) => {
    // Settle the snapshot at the live effective balance before the new
    // auto-deduction state takes effect. This handles BOTH transitions:
    //   - true → false: deduct the elapsed period at the OLD active
    //     rate, then flip OFF. Without this, the displayed balance
    //     would jump back up to the stale snapshot value the moment
    //     the flag flips (because effectiveCurrentPills returns
    //     currentPills unchanged when autoDeduct is false), undoing
    //     all consumption since lastSyncDate.
    //   - false → true: keep currentPills unchanged (the user wasn't
    //     consuming during the frozen period), bump lastSyncDate=today
    //     so the new auto-deduction starts fresh from today. Without
    //     the lastSyncDate bump, enabling auto-deduction would
    //     retroactively deduct daysPassed*dailyDose for the frozen
    //     period.
    //
    // IMPORTANT: the settle calculation + all side effects (setLogs,
    // showToast) must run OUTSIDE the setMedications updater. React
    // updater functions must be pure — React may invoke them more than
    // once in Strict Mode (which would create duplicate settlement
    // logs and duplicate toasts). We compute the settle result once
    // here, fire the side effects once, and pass the result into the
    // updater as a closure value (which the updater only READS).
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;

    const today = getTodayDateString();
    // `autoDeductEnabled` defaults to true when undefined, so the
    // effective current state is `!== false`. To toggle OFF from the
    // default-true (undefined) state we must set false explicitly.
    // #27: the previous `!m.autoDeductEnabled` formulation no-oped
    // for the undefined case because `!undefined === true` — the
    // first click on a med with autoDeductEnabled===undefined kept
    // it ON. `med.autoDeductEnabled === false` correctly maps:
    //   undefined → false (turn OFF the default-true)
    //   true      → false (turn OFF)
    //   false     → true  (turn ON)
    const newState = med.autoDeductEnabled === false;
    const { updatedMed, log: settleLog } = settleAutoDeductToggle(
      med,
      newState,
      today
    );

    // Side effect 1: persist the settlement consumption log (if any
    // pills were deducted during the true→false transition). Runs
    // OUTSIDE the medications updater so Strict Mode double-invoke
    // can't duplicate the log.
    if (settleLog) {
      setLogs((prevLogs) => [settleLog, ...prevLogs]);
    }
    // Side effect 2: toast the toggle result. Also outside the updater.
    showToast(
      newState ? `تم تفعيل الخصم التلقائي لـ "${med.name}"` : `تم إيقاف الخصم التلقائي مؤقتاً لـ "${med.name}"`
    );

    if (soundEnabled) playSuccessChime();

    // Updater: pure — only reads `updatedMed` from the closure and
    // returns the new medications array. No side effects inside.
    setMedications((prev) =>
      prev.map((m) => (m.id === medicationId ? updatedMed : m))
    );
  };

  const handleToggleGlobalAutoDeduct = () => {
    const next = !globalAutoDeductEnabled;
    setGlobalAutoDeductEnabled(next);
    const today = getTodayDateString();

    if (!next) {
      // Turning OFF: settle all medications at their current effective balance
      let totalDeducted = 0;
      const newLogs: ConsumptionLog[] = [];
      const settledMeds = medications.map((med) => {
        const { updatedMed, log } = settleAutoDeductToggle(med, false, today);
        if (log) {
          newLogs.push(log);
          totalDeducted += Math.abs(log.amount);
        }
        return updatedMed;
      });

      setMedications(settledMeds);
      if (newLogs.length > 0) {
        setLogs((prev) => [...newLogs, ...prev]);
      }

      showToast(
        totalDeducted > 0
          ? `تم إيقاف الخصم التلقائي لجميع الأدوية (تمت تسوية خصم ${totalDeducted} قرص للأيام السابقة).`
          : 'تم إيقاف الخصم التلقائي لجميع الأدوية ⏸️ (المخزون ثابت الآن)'
      );
    } else {
      // Turning ON: reactivate all medications, resetting lastSyncDate to today
      const reactivatedMeds = medications.map((med) => {
        const { updatedMed } = settleAutoDeductToggle(med, true, today);
        return updatedMed;
      });

      setMedications(reactivatedMeds);
      showToast('تم تفعيل الخصم التلقائي اليومي لجميع الأدوية ⚡');
    }

    if (soundEnabled) playSuccessChime();
  };

  const handleConfirmAutoDeductPrompt = (enable: boolean) => {
    setIsAutoDeductPromptOpen(false);
    persist(STORAGE_AUTO_DEDUCT_PROMPTED_KEY, 'true', { json: false });
    setGlobalAutoDeductEnabled(enable);
    persist(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, String(enable), { json: false });
    if (soundEnabled) playSuccessChime();
    showToast(
      enable
        ? 'تم تفعيل الخصم التلقائي لمخزون الأدوية ⚡'
        : 'تم إيقاف الخصم التلقائي ⏸️ (المخزون ثابت حتى تسجل الجرعة يدوياً)'
    );
  };



  const handleSaveMedication = (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => {
    if (editId) {
      // Settlement: if the user is changing the dailyDose, we MUST NOT
      // just apply the new dose going forward from lastSyncDate — that
      // would retroactively apply the new rate to all days that
      // actually consumed at the OLD rate. Instead, settle the period
      // [lastSyncDate, today] at the OLD dose first, then apply the
      // new dose from today forward.
      const existing = medications.find((m) => m.id === editId);
      const today = getTodayDateString();
      const isDoseChanging =
        existing && medData.dailyDose !== existing.dailyDose;
      if (existing && isDoseChanging) {
        const { updatedMed, log } = settleDoseChange(
          existing,
          medData.dailyDose,
          today
        );
        // Merge the settled med with the rest of the form data (name,
        // category, reminder settings, etc.) — but keep the settled
        // currentPills + lastSyncDate (don't let the form overwrite them).
        const pruned = pruneDoseConsumption(medData, existing);
        setMedications((prev) =>
          prev.map((m) =>
            m.id === editId
              ? {
                  ...m,
                  ...pruned,
                  // Override medData.currentPills + lastSyncDate with
                  // the settled values. medData.currentPills in edit
                  // mode equals initialData.currentPills (the input is
                  // disabled), but settleDoseChange may have reduced it
                  // for the elapsed days at the old dose — we MUST use
                  // that reduced value, not the form's disabled-input
                  // echo of the pre-edit snapshot.
                  currentPills: updatedMed.currentPills,
                  lastSyncDate: updatedMed.lastSyncDate,
                }
              : m
          )
        );
        // Log the settlement consumption if any pills were deducted.
        if (log) {
          setLogs((prev) => [log, ...prev]);
        }
      } else {
        // No dose change (or new med): just save normally.
        const pruned = pruneDoseConsumption(medData, existing);
        setMedications((prev) => prev.map((m) => (m.id === editId ? { ...m, ...pruned } : m)));
      }
      showToast(
        medData.reminderEnabled
          ? `تم حفظ "${medData.name}" مع تذكير يومي الساعة ${medData.reminderTime}`
          : `تم تعديل بيانات "${medData.name}" بنجاح`
      );
    } else {
      const newMed: Medication = {
        ...medData,
        id: 'med-' + Date.now(),
        createdAt: new Date().toISOString(),
        lastSyncDate: getTodayDateString(),
        autoDeductEnabled: globalAutoDeductEnabled,
      };
      setMedications((prev) => [newMed, ...prev]);
      showToast(
        newMed.reminderEnabled
          ? `تمت إضافة "${newMed.name}" مع تنبيه الساعة ${newMed.reminderTime}`
          : `تمت إضافة "${newMed.name}"، وسيحسب استهلاكه تلقائياً`
      );
    }
    if (soundEnabled) playSuccessChime();
    setEditingMedication(null);
  };


  const handleDeleteMedication = (id: string) => {
    const med = medications.find((m) => m.id === id);
    if (!med) return;
    setMedications((prev) => prev.filter((m) => m.id !== id));
    showToast(`تم حذف "${med.name}" من القائمة`);
  };


  const handleTakeDoseFromAlarm = useCallback((med: Medication, doseId?: string) => {
    // Phase 4: durable gate — same serialization as exact auto reconciliation.
    void (async () => {
      const result = await runGatedManualConsume({
        medicationId: med.id,
        doseId,
        source: 'alarm',
      });
      if (result.outcome === 'applied' && result.log) {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
        showToast(TOAST_MESSAGES.doseTaken(med.name, result.doseAmount, med.unit));
        if (soundEnabled) playSuccessChime();
      } else if (result.outcome === 'already_consumed') {
        showToast(TOAST_MESSAGES.doseAlreadyTaken(med.name));
      }
      // Dismiss only when durable Take applied or occurrence already settled.
      // persist_failed must keep the alarm so the user can retry.
      if (shouldDismissAlarmAfterManualTake(result.outcome)) {
        dismissAlarm();
      }
    })();
  }, [dismissAlarm, soundEnabled]);


  const handleSnoozeFromAlarm = (med: Medication) => {
    snoozeAlarm(med, DEFAULT_SNOOZE_MINUTES);
    showToast(TOAST_MESSAGES.doseSnoozed(med.name));
  };

  // Open the Android exact-alarm settings screen so the user can grant
  // SCHEDULE_EXACT_ALARM. On web this is a no-op. After the user returns
  // to the app, the appStateChange listener re-checks the permission
  // and updates exactAlarmEnabled → the scheduler reschedules.

  const handleConsumeDose = (medicationId: string, doseId?: string) => {
    const med = medicationsRef.current.find((m) => m.id === medicationId);
    if (!med) return;
    const isMulti =
      Array.isArray(med.doseSchedule) && med.doseSchedule.length > 1;

    // Multi-dose: never guess — open unified management UI when doseId missing.
    if (isMulti && !doseId) {
      flushSync(() => {
        setSelectDoseMode('manage');
      });
      setSelectDoseMed(medicationsRef.current.find((m) => m.id === medicationId) ?? med);
      return;
    }

    // Single-dose schedule (length === 1): use that dose id if present.
    const resolvedDoseId =
      doseId ??
      (Array.isArray(med.doseSchedule) && med.doseSchedule.length === 1
        ? med.doseSchedule[0].id
        : undefined);

    // Phase 4: durable gate serialize with exact auto-deduction.
    void (async () => {
      const result = await runGatedManualConsume({
        medicationId,
        doseId: resolvedDoseId,
        source: 'manual',
      });
      if (result.outcome === 'applied' && result.log) {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
        const updatedMed = result.medications.find((m) => m.id === medicationId);
        if (selectDoseModeRef.current === 'manage' && updatedMed) {
          setSelectDoseMed(updatedMed);
        } else {
          setSelectDoseMed(null);
          setSelectDoseMode('take');
        }
        showToast(TOAST_MESSAGES.doseTaken(med.name, result.doseAmount, med.unit));
        if (soundEnabled) playSuccessChime();
        return;
      }
      if (
        result.outcome === 'already_consumed' ||
        result.reason === 'already_consumed'
      ) {
        showToast(TOAST_MESSAGES.doseAlreadyTaken(med.name));
        return;
      }
      // persist_failed: durable write did not complete — not "already taken".
      if (result.outcome === 'persist_failed') {
        showToast(STORAGE_ERRORS.generic);
        return;
      }
      // rejected / missing_med / other — do not claim already taken.
      if (result.outcome === 'missing_med') {
        return;
      }
      // rejected: leave UI unchanged; no false already-taken toast.
    })();
  };

  /**
   * Card toggle restore.
   * Multi-dose without doseId → same SelectDoseModal UX as Take (restore mode).
   * Single-dose / legacy / explicit doseId → direct restoreDose path.
   *
   * Mode is committed with flushSync before selectDoseMed so the first
   * SelectDoseModal render after open always sees mode='restore'. Otherwise
   * a take-mode first paint marks manually-consumed doses disabled
   * (isSelectable = !completed).
   */
  const handleCardRestoreDose = (medicationId: string, doseId?: string) => {
    const med = medicationsRef.current.find((m) => m.id === medicationId);
    if (!med) return;
    const isMulti =
      Array.isArray(med.doseSchedule) && med.doseSchedule.length > 1;

    if (isMulti && !doseId) {
      flushSync(() => {
        setSelectDoseMode('manage');
      });
      setSelectDoseMed(med);
      return;
    }

    void (async () => {
      const updated = await handleRestoreDose(medicationId, 'card', doseId);
      if (updated) {
        if (selectDoseModeRef.current === 'manage') {
          setSelectDoseMed(updated);
        } else {
          setSelectDoseMed(null);
          setSelectDoseMode('take');
        }
        showToast(`تم استرجاع الجرعة — ${med.name}`);
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
  // handleToggleCriticalStockAlerts must be async because it requests
  // notification permission when turning ON. Previously it was a sync
  // useCallback that always flipped the toggle on without checking
  // permission — now it requests permission first and does NOT activate
  // if the user denies.
  const handleToggleCriticalStockAlerts = useCallback(async () => {
    const next = !criticalStockAlertsEnabled;
    if (!next) {
      // Turning OFF — always allowed.
      setCriticalStockAlertsEnabled(false);
      showToast(TOAST_MESSAGES.criticalAlertsOff);
      return;
    }

    // Turning ON — ensure notification permission is granted first.
    // If notifications aren't enabled yet (or permission is missing),
    // request it. On denial, do NOT activate the toggle.
    if (!notificationsEnabled) {
      let pushAllowed = false;
      try {
        const currentPerm = await getNotificationPermission();
        if (currentPerm === 'granted') {
          pushAllowed = true;
        } else if (currentPerm === 'default') {
          pushAllowed = await requestNotificationPermission();
        }
      } catch (err) {
        console.warn('[App] Notification permission error (critical toggle):', err);
      }
      if (!pushAllowed) {
        showToast(TOAST_MESSAGES.notificationsPermissionDenied);
        return;
      }
      // Permission granted → also flip the notifications toggle on.
      setNotificationsEnabled(true);
    }

    setCriticalStockAlertsEnabled(true);
    if (soundEnabled) playSuccessChime();
    showToast(TOAST_MESSAGES.criticalAlertsOn);
  }, [criticalStockAlertsEnabled, notificationsEnabled, soundEnabled, showToast]);

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
    handleSnoozeFromAlarm,
    handleConsumeDose,
    handleCardRestoreDose,
    handleSelectDoseFromModal,
    handleToggleCriticalStockAlerts,
  };
}
