import type { Dispatch, SetStateAction } from 'react';
import type {
  ConsumptionLog,
  Medication,
  PharmacySettings,
} from '../types';
import { DEFAULT_PHARMACY_SETTINGS } from '../types';
import {
  requestNotificationPermission,
  getNotificationPermission,
} from './notifications/notificationPermissions';
import { getExactAlarmPermission, type ExactAlarmPermission } from './exactAlarm';
import { initNativeBridge } from '../native';
import {
  ensureNotificationChannel,
  getNotificationChannelState,
  retryPersistedNotificationDeliveries,
} from './notificationRuntime';
import {
  DOSE_REMINDER_CHANNEL_ID,
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
} from './notifications/doseReminderNotifications';
import {
  isValidConsumptionLogRecord,
  isValidMedicationRecord,
  loadString,
  persist,
  readJsonOutcome,
  readStorageItem,
} from './storage';
import { convergeAutoDeductionStock } from './autoDeductionNativeStock';
import {
  STORAGE_MEDS_KEY,
  STORAGE_LOGS_KEY,
  STORAGE_PHARMACY_KEY,
  STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
  STORAGE_AUTO_DEDUCT_PROMPTED_KEY,
  SOUND_KEY,
  NOTIFICATIONS_KEY,
  FONT_SIZE_KEY,
  CRITICAL_STOCK_ALERTS_KEY,
  COMPACT_VIEW_KEY,
} from '../constants/storageKeys';

export interface AppHydrationPhaseSetters {
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
}

export interface PersistedAppHydrationState {
  isFirstEverOpen: boolean;
  loadedMedications: Medication[];
  shouldShowAutoDeductPrompt: boolean;
}

/** Runtime-validated pharmacy-settings parser for durable reads. */
function parsePharmacySettings(
  raw: unknown
): Partial<PharmacySettings> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Partial<PharmacySettings>;
}

/**
 * Phase 1: load persisted application state and establish the initial
 * first-run/preference state before asynchronous capability work starts.
 */
export function loadPersistedAppState(
  setters: Pick<
    AppHydrationPhaseSetters,
    | 'setLogs'
    | 'setPharmacySettings'
    | 'setIsFirstRun'
    | 'setSoundEnabled'
    | 'setNotificationsEnabled'
    | 'setCriticalStockAlertsEnabled'
    | 'setGlobalAutoDeductEnabled'
    | 'setFontScale'
    | 'setIsCompactView'
  >
): PersistedAppHydrationState {
  const savedMedsStorage = readStorageItem(STORAGE_MEDS_KEY);
  const autoDeductPromptedStorage = readStorageItem(STORAGE_AUTO_DEDUCT_PROMPTED_KEY);

  if (!savedMedsStorage.ok) {
    console.warn('[App] Medication storage read failed; starting with empty state.');
  }
  if (!autoDeductPromptedStorage.ok) {
    console.warn('[App] Auto-deduct prompt storage read failed; skipping first-run prompt.');
  }

  const isFirstEverOpen = savedMedsStorage.ok && savedMedsStorage.value === null;
  let loadedMedications: Medication[] = [];
  const shouldShowAutoDeductPrompt =
    isFirstEverOpen
    && autoDeductPromptedStorage.ok
    && autoDeductPromptedStorage.value === null;

  if (isFirstEverOpen) {
    setters.setIsFirstRun(true);
  } else {
    // Hydration distinguishes missing vs invalid vs unreadable durable state.
    // A corrupt medication snapshot is never treated as an authoritative
    // empty list — startup proceeds fail-safe with a loud diagnostic.
    const medsOutcome = readJsonOutcome(STORAGE_MEDS_KEY, (raw) =>
      Array.isArray(raw) && raw.every(isValidMedicationRecord) ? raw : null
    );
    if (medsOutcome.status === 'ok') {
      loadedMedications = medsOutcome.value;
    } else if (medsOutcome.status === 'invalid' || medsOutcome.status === 'read_failed') {
      console.warn(
        `[App] Persisted medication state unusable (${medsOutcome.status}: ${medsOutcome.reason}); starting fail-safe.`
      );
    }
  }

  const logsOutcome = readJsonOutcome(STORAGE_LOGS_KEY, (raw) =>
    Array.isArray(raw) && raw.every(isValidConsumptionLogRecord) ? raw : null
  );
  if (logsOutcome.status === 'ok') {
    setters.setLogs(logsOutcome.value);
  } else if (logsOutcome.status === 'invalid' || logsOutcome.status === 'read_failed') {
    console.warn(
      `[App] Persisted consumption-log state unusable (${logsOutcome.status}: ${logsOutcome.reason}); starting fail-safe.`
    );
  }

  const pharmacyOutcome = readJsonOutcome(STORAGE_PHARMACY_KEY, parsePharmacySettings);
  const parsedPharmacy = pharmacyOutcome.status === 'ok' ? pharmacyOutcome.value : null;
  if (pharmacyOutcome.status === 'invalid' || pharmacyOutcome.status === 'read_failed') {
    console.warn(
      `[App] Persisted pharmacy settings unusable (${pharmacyOutcome.status}); keeping defaults.`
    );
  }
  if (parsedPharmacy) {
    const pharmacies = Array.isArray(parsedPharmacy.pharmacies)
      ? parsedPharmacy.pharmacies
      : [];
    const whatsappContacts = Array.isArray(parsedPharmacy.whatsappContacts)
      ? parsedPharmacy.whatsappContacts
      : [];
    const whatsappAddresses = Array.isArray(parsedPharmacy.whatsappAddresses)
      ? parsedPharmacy.whatsappAddresses
      : [];
    const selectedWhatsappContactIds = Array.isArray(parsedPharmacy.selectedWhatsappContactIds)
      ? parsedPharmacy.selectedWhatsappContactIds
      : [];
    const selectedWhatsappAddressIds = Array.isArray(parsedPharmacy.selectedWhatsappAddressIds)
      ? parsedPharmacy.selectedWhatsappAddressIds
      : [];
    const defaultDurationDays =
      parsedPharmacy.defaultDurationDays === 60
        ? 60
        : DEFAULT_PHARMACY_SETTINGS.defaultDurationDays;

    setters.setPharmacySettings({
      defaultDurationDays,
      pharmacies,
      selectedPharmacyId:
        typeof parsedPharmacy.selectedPharmacyId === 'string' && parsedPharmacy.selectedPharmacyId
          ? parsedPharmacy.selectedPharmacyId
          : pharmacies[0]?.id || '',
      whatsappContacts,
      whatsappAddresses,
      selectedWhatsappContactIds,
      selectedWhatsappAddressIds,
    });
  }

  setters.setSoundEnabled(loadString(SOUND_KEY, 'true') !== 'false');

  const savedNotifications = readStorageItem(NOTIFICATIONS_KEY);
  if (
    savedNotifications.ok
    && (savedNotifications.value === 'true' || savedNotifications.value === 'false')
  ) {
    setters.setNotificationsEnabled(savedNotifications.value === 'true');
  }

  if (loadString(FONT_SIZE_KEY, 'normal') === 'large') {
    setters.setFontScale('large');
  }

  const savedCritical = loadString(CRITICAL_STOCK_ALERTS_KEY, '');
  if (savedCritical === 'true' || savedCritical === 'false') {
    setters.setCriticalStockAlertsEnabled(savedCritical === 'true');
  } else {
    setters.setCriticalStockAlertsEnabled(false);
  }

  setters.setGlobalAutoDeductEnabled(
    loadString(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true') !== 'false'
  );

  if (loadString(COMPACT_VIEW_KEY, 'false') === 'true') {
    setters.setIsCompactView(true);
  }

  return {
    isFirstEverOpen,
    loadedMedications,
    shouldShowAutoDeductPrompt,
  };
}

/**
 * Apply an asynchronous first-open notification permission result only while
 * the preference is still unset. An explicit persisted preference always wins.
 * A storage read failure also leaves the current state untouched because the
 * helper cannot prove that the preference is unset.
 */
export function applyNotificationPermissionResultIfUnset(
  granted: boolean,
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>
): void {
  const savedPreference = readStorageItem(NOTIFICATIONS_KEY);
  if (savedPreference.ok && savedPreference.value === null) {
    setNotificationsEnabled(granted);
  }
}

async function initializeNotificationPermission(
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>
): Promise<void> {
  const perm = await getNotificationPermission();
  const savedPreference = readStorageItem(NOTIFICATIONS_KEY);

  if (
    savedPreference.ok
    && savedPreference.value === 'true'
    && perm !== 'granted'
  ) {
    setNotificationsEnabled(false);
    return;
  }

  if (savedPreference.ok && savedPreference.value === 'true') {
    setNotificationsEnabled(true);
    return;
  }

  if (savedPreference.ok && savedPreference.value === null) {
    if (perm === 'default') {
      // Wait for the first-open OS decision before hydration can publish
      // readiness. Otherwise the hydrated-state persistence effect could
      // save the initial false state and make that value look explicit before
      // the async grant/denial result arrives.
      const granted = await requestNotificationPermission();
      applyNotificationPermissionResultIfUnset(granted, setNotificationsEnabled);
      return;
    }

    setNotificationsEnabled(perm === 'granted');
  }
}

/**
 * Phase 2a: initialize notification/exact-alarm capabilities.
 */
export async function initializeAppPermissions(
  setters: Pick<
    AppHydrationPhaseSetters,
    'setNotificationsEnabled' | 'setExactAlarmPermission'
  >
): Promise<void> {
  await Promise.all([
    initializeNotificationPermission(setters.setNotificationsEnabled).catch((err) => {
      console.warn('[App] getNotificationPermission failed:', err);
    }),
    getExactAlarmPermission()
      .then((state) => {
        setters.setExactAlarmPermission(state);
      })
      .catch((err) => {
        console.warn('[App] getExactAlarmPermission failed:', err);
      }),
  ]);
}

/**
 * Phase 2b: initialize the native runtime and verify notification channels.
 * This is separate from permission lookup, but the coordinator starts both
 * phases concurrently to preserve the existing startup ordering.
 */
export async function initializeNativeRuntime(
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>
): Promise<void> {
  await initNativeBridge();
  void retryPersistedNotificationDeliveries();

  // #503: bootstrap the required Dose Reminder channels BEFORE their
  // existence is used as a scheduling gate. Notification Runtime owns
  // channel creation; Dose Reminder owns its channel descriptors. On a
  // clean install the channels are created deterministically here, so a
  // valid persisted preference is never flipped to disabled merely because
  // the channels did not exist yet. A genuinely disabled channel or an OS
  // notification denial still reports 'disabled' after bootstrap.
  await Promise.all([
    ensureNotificationChannel({
      channelId: DOSE_REMINDER_CHANNEL_ID,
      channelName: DOSE_REMINDER_CHANNEL_ID,
      channelImportance: 4,
    }),
    ensureNotificationChannel({
      channelId: DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
      channelName: DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
      channelImportance: 2,
    }),
  ]).catch((err) => {
    console.warn('[App] Dose Reminder channel bootstrap failed:', err);
  });

  const [backgroundChannel, foregroundChannel] = await Promise.all([
    getNotificationChannelState(DOSE_REMINDER_CHANNEL_ID),
    getNotificationChannelState(DOSE_REMINDER_FOREGROUND_CHANNEL_ID),
  ]);

  const savedPreference = readStorageItem(NOTIFICATIONS_KEY);
  // #482: only a REAL OS denial ('disabled') may flip the persisted
  // preference off. An 'unknown' capability state (transient native error)
  // leaves the user's preference untouched. (#503 adds channel bootstrap
  // before this gate so a missing channel is created, not treated as denial.)
  if (
    savedPreference.ok
    && savedPreference.value === 'true'
    && (backgroundChannel === 'disabled' || foregroundChannel === 'disabled')
  ) {
    setNotificationsEnabled(false);
  }
}

/**
 * Phase 3: converge Android Auto-owned stock into the hydrated JS medication
 * state. Failures remain fail-closed and do not block readiness.
 */
export async function convergeHydratedStock(
  state: Pick<PersistedAppHydrationState, 'isFirstEverOpen' | 'loadedMedications'>,
  setMedications: Dispatch<SetStateAction<Medication[]>>
): Promise<void> {
  if (state.isFirstEverOpen || state.loadedMedications.length === 0) return;

  try {
    const native = await convergeAutoDeductionStock(state.loadedMedications);
    if (native.ok) {
      setMedications(native.medications);

      const currentRaw = JSON.stringify(state.loadedMedications);
      const nativeRaw = JSON.stringify(native.medications);
      if (currentRaw !== nativeRaw) {
        const persistError = persist(
          STORAGE_MEDS_KEY,
          native.medications,
          { json: true }
        );
        if (persistError) {
          console.warn(
            '[App] Native Auto stock converged but JS stock mirror persist failed:',
            persistError
          );
        }
      }
      return;
    }

    setMedications(state.loadedMedications);
    console.warn(
      '[App] Native Auto stock convergence failed during hydration:',
      native.error
    );
  } catch (err) {
    setMedications(state.loadedMedications);
    console.warn('[App] Native Auto stock hydration failed:', err);
  }
}

/**
 * Phase 4: publish readiness only after every prerequisite phase settles.
 */
export function publishHydrationReadiness(
  setHydrated: Dispatch<SetStateAction<boolean>>,
  shouldShowAutoDeductPrompt: boolean,
  setIsAutoDeductPromptOpen: Dispatch<SetStateAction<boolean>>
): void {
  setHydrated(true);
  if (shouldShowAutoDeductPrompt) {
    setIsAutoDeductPromptOpen(true);
  }
}
