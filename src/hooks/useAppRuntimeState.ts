import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Medication, ConsumptionLog, PharmacySettings } from '../types';
import { DEFAULT_PHARMACY_SETTINGS } from '../types';
import type { ExactAlarmPermission } from '../utils/exactAlarm';

export interface AppRuntimeState {
  medications: Medication[];
  logs: ConsumptionLog[];
  pharmacySettings: PharmacySettings;
  hydrated: boolean;
  isFirstRun: boolean;
  isAutoDeductPromptOpen: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  criticalAlarmResumeTick: number;
  doseAlarmResumeTick: number;
  doseLifecycleTick: number;
  globalAutoDeductEnabled: boolean;
  fontScale: 'normal' | 'large';
  isCompactView: boolean;
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
  setMedications: Dispatch<SetStateAction<Medication[]>>;
  setLogs: Dispatch<SetStateAction<ConsumptionLog[]>>;
  setPharmacySettings: Dispatch<SetStateAction<PharmacySettings>>;
  setHydrated: Dispatch<SetStateAction<boolean>>;
  setIsFirstRun: Dispatch<SetStateAction<boolean>>;
  setIsAutoDeductPromptOpen: Dispatch<SetStateAction<boolean>>;
  setSoundEnabled: Dispatch<SetStateAction<boolean>>;
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>;
  setCriticalStockAlertsEnabled: Dispatch<SetStateAction<boolean>>;
  setExactAlarmPermission: Dispatch<SetStateAction<ExactAlarmPermission | null>>;
  setGlobalAutoDeductEnabled: Dispatch<SetStateAction<boolean>>;
  setFontScale: Dispatch<SetStateAction<'normal' | 'large'>>;
  setIsCompactView: Dispatch<SetStateAction<boolean>>;
  setDoseLifecycleTick: Dispatch<SetStateAction<number>>;
  setCriticalAlarmResumeTick: Dispatch<SetStateAction<number>>;
  setDoseAlarmResumeTick: Dispatch<SetStateAction<number>>;
}

export function useAppRuntimeState(): AppRuntimeState {
  const [medications, setMedications] = useState<Medication[]>([]);
  const [logs, setLogs] = useState<ConsumptionLog[]>([]);
  const [pharmacySettings, setPharmacySettings] =
    useState<PharmacySettings>(DEFAULT_PHARMACY_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [isAutoDeductPromptOpen, setIsAutoDeductPromptOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [criticalStockAlertsEnabled, setCriticalStockAlertsEnabled] = useState(false);
  const [exactAlarmPermission, setExactAlarmPermission] = useState<ExactAlarmPermission | null>(null);
  const [criticalAlarmResumeTick, setCriticalAlarmResumeTick] = useState(0);
  const [doseAlarmResumeTick, setDoseAlarmResumeTick] = useState(0);
  const [doseLifecycleTick, setDoseLifecycleTick] = useState(0);
  const [globalAutoDeductEnabled, setGlobalAutoDeductEnabled] = useState(true);
  const [fontScale, setFontScale] = useState<'normal' | 'large'>('normal');
  const [isCompactView, setIsCompactView] = useState(false);

  const allowManualTakeActionByMedicationId = useMemo(() => {
    const result = new Map<string, boolean>();
    for (const medication of medications) {
      // Global OFF makes Auto inactive at runtime while preserving each
      // medication's persisted Auto preference.
      result.set(
        medication.id,
        globalAutoDeductEnabled === false || medication.autoDeductEnabled === false
      );
    }
    return result;
  }, [medications, globalAutoDeductEnabled]);

  return {
    medications,
    logs,
    pharmacySettings,
    hydrated,
    isFirstRun,
    isAutoDeductPromptOpen,
    soundEnabled,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    exactAlarmPermission,
    criticalAlarmResumeTick,
    doseAlarmResumeTick,
    doseLifecycleTick,
    globalAutoDeductEnabled,
    fontScale,
    isCompactView,
    allowManualTakeActionByMedicationId,
    setMedications,
    setLogs,
    setPharmacySettings,
    setHydrated,
    setIsFirstRun,
    setIsAutoDeductPromptOpen,
    setSoundEnabled,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    setExactAlarmPermission,
    setGlobalAutoDeductEnabled,
    setFontScale,
    setIsCompactView,
    setDoseLifecycleTick,
    setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
  };
}
