import type { ConsumptionLog, Medication, MedicationDose, Pharmacy, PharmacySettings, UserAddress, UserContact } from '../types';
import { generateId } from './id';
import { isValidTimeHhmm } from './time';
import { isValidMedicationRecord, isValidConsumptionLogRecord } from './storage';

export type BackupScope = 'medications' | 'all';

export interface DrugTrackerBackup {
  version: 1;
  app: 'drug-tracker';
  scope: BackupScope;
  exportedAt: string;
  metadata: {
    medicationsCount: number;
    logsCount: number;
    pharmaciesCount: number;
    contactsCount: number;
    addressesCount: number;
    appVersion: string;
  };
  medications: Medication[];
  logs?: ConsumptionLog[] | undefined;
  pharmacySettings?: PharmacySettings | undefined;
}

export interface ParsedBackupData {
  scope?: BackupScope | undefined;
  exportedAt?: string | undefined;
  medications: Medication[];
  logs: ConsumptionLog[];
  pharmacySettings?: PharmacySettings | undefined;
  rawCount: number;
  validCount: number;
}

export type BackupValidationResult =
  | { ok: true; data: ParsedBackupData }
  | { ok: false; error: string };

/**
 * Creates an exportable backup payload according to the chosen scope:
 * - 'medications': Includes only the medications array.
 * - 'all': Includes medications, consumption logs, pharmacies, whatsapp phone numbers, and addresses.
 */
export function createBackupPayload(
  scope: BackupScope,
  medications: Medication[],
  logs?: ConsumptionLog[],
  pharmacySettings?: PharmacySettings
): DrugTrackerBackup {
  const isAll = scope === 'all';
  const effectiveLogs = isAll ? (logs ?? []) : [];
  const effectivePharmacySettings = isAll ? pharmacySettings : undefined;

  return {
    version: 1,
    app: 'drug-tracker',
    scope,
    exportedAt: new Date().toISOString(),
    metadata: {
      medicationsCount: medications.length,
      logsCount: effectiveLogs.length,
      pharmaciesCount: effectivePharmacySettings?.pharmacies?.length ?? 0,
      contactsCount: effectivePharmacySettings?.whatsappContacts?.length ?? 0,
      addressesCount: effectivePharmacySettings?.whatsappAddresses?.length ?? 0,
      appVersion: '0.1.0',
    },
    medications,
    logs: isAll ? effectiveLogs : undefined,
    pharmacySettings: effectivePharmacySettings,
  };
}

/**
 * Initiates the client-side download of the JSON backup file.
 */
export function downloadBackupFile(
  backup: DrugTrackerBackup,
  customFilename?: string
): { ok: boolean; filename: string; error?: string } {
  try {
    const jsonStr = JSON.stringify(backup, null, 2);
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toTimeString().slice(0, 5).replace(':', '-');
    const scopePrefix = backup.scope === 'all' ? 'drug-tracker-full-backup' : 'drug-tracker-medications';
    const filename = customFilename || `${scopePrefix}-${dateStr}_${timeStr}.json`;

    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Revoke object URL after slight delay to allow download to start
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }, 2000);

    return { ok: true, filename };
  } catch (err) {
    return {
      ok: false,
      filename: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Normalizes a raw candidate dose record into a strictly valid MedicationDose.
 */
function normalizeDose(raw: unknown, index: number): MedicationDose | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const id = typeof d.id === 'string' && d.id.trim() ? d.id.trim() : generateId(`dose_${index}`);
  const amount = typeof d.amount === 'number' && Number.isFinite(d.amount) && d.amount > 0 ? d.amount : 1;
  const time = typeof d.time === 'string' && isValidTimeHhmm(d.time) ? d.time : '08:00';
  const description = typeof d.description === 'string' ? d.description : undefined;

  return { id, amount, time, description };
}

/**
 * Normalizes a raw medication record from a backup file with safe defaults.
 * Guarantees that valid medications from older backups or external files
 * can be cleanly imported without being discarded due to minor missing fields.
 */
export function normalizeMedicationForImport(raw: unknown): Medication | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  // Name is strictly required
  if (typeof r.name !== 'string' || !r.name.trim()) {
    return null;
  }
  const name = r.name.trim();

  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : generateId('med');
  const currentPills =
    typeof r.currentPills === 'number' && Number.isFinite(r.currentPills) && r.currentPills >= 0
      ? r.currentPills
      : 0;

  const dailyDose =
    typeof r.dailyDose === 'number' && Number.isFinite(r.dailyDose) && r.dailyDose > 0
      ? r.dailyDose
      : 1;

  const unit = typeof r.unit === 'string' && r.unit.trim() ? r.unit.trim() : 'قرص';

  const warningThresholdDays =
    typeof r.warningThresholdDays === 'number' &&
    Number.isFinite(r.warningThresholdDays) &&
    r.warningThresholdDays >= 0
      ? r.warningThresholdDays
      : 5;

  const colorTag = typeof r.colorTag === 'string' && r.colorTag.trim() ? r.colorTag.trim() : 'teal';

  const createdAt =
    typeof r.createdAt === 'string' && r.createdAt.trim()
      ? r.createdAt.trim()
      : new Date().toISOString();

  // Normalize doses
  let doseSchedule: MedicationDose[] | undefined;
  if (Array.isArray(r.doseSchedule)) {
    const doses: MedicationDose[] = [];
    r.doseSchedule.forEach((item, idx) => {
      const parsed = normalizeDose(item, idx);
      if (parsed) doses.push(parsed);
    });
    if (doses.length > 0) {
      doseSchedule = doses;
    }
  }

  // If doseSchedule is not defined but dailyDose > 0, create default single slot
  if (!doseSchedule || doseSchedule.length === 0) {
    const time = typeof r.reminderTime === 'string' && isValidTimeHhmm(r.reminderTime) ? r.reminderTime : '08:00';
    doseSchedule = [
      {
        id: generateId('dose_default'),
        amount: dailyDose,
        time,
      },
    ];
  }

  const dosesPerDay = doseSchedule.length;

  const autoDeductEnabled =
    typeof r.autoDeductEnabled === 'boolean' ? r.autoDeductEnabled : true;

  const isChronic = typeof r.isChronic === 'boolean' ? r.isChronic : undefined;

  const durationDays =
    typeof r.durationDays === 'number' && Number.isFinite(r.durationDays) && r.durationDays > 0
      ? r.durationDays
      : undefined;

  const treatmentStartDate =
    typeof r.treatmentStartDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.treatmentStartDate)
      ? r.treatmentStartDate
      : undefined;

  const category = typeof r.category === 'string' && r.category.trim() ? r.category.trim() : undefined;
  const notes = typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : undefined;

  const packageSize =
    typeof r.packageSize === 'number' && Number.isFinite(r.packageSize) && r.packageSize > 0
      ? r.packageSize
      : undefined;

  const stripsPerBox =
    typeof r.stripsPerBox === 'number' && Number.isFinite(r.stripsPerBox) && r.stripsPerBox > 0
      ? r.stripsPerBox
      : undefined;

  const pillsPerStrip =
    typeof r.pillsPerStrip === 'number' && Number.isFinite(r.pillsPerStrip) && r.pillsPerStrip > 0
      ? r.pillsPerStrip
      : undefined;

  const targetOrderQuantity =
    typeof r.targetOrderQuantity === 'number' &&
    Number.isFinite(r.targetOrderQuantity) &&
    r.targetOrderQuantity > 0
      ? r.targetOrderQuantity
      : undefined;

  const reminderEnabled = typeof r.reminderEnabled === 'boolean' ? r.reminderEnabled : false;
  const reminderTime =
    typeof r.reminderTime === 'string' && isValidTimeHhmm(r.reminderTime)
      ? r.reminderTime
      : doseSchedule[0]?.time;

  const criticalStockAlertsEnabled =
    typeof r.criticalStockAlertsEnabled === 'boolean' ? r.criticalStockAlertsEnabled : true;

  const lastConsumedDate =
    typeof r.lastConsumedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.lastConsumedDate)
      ? r.lastConsumedDate
      : undefined;

  const doseConsumptionHistory =
    r.doseConsumptionHistory && typeof r.doseConsumptionHistory === 'object' && !Array.isArray(r.doseConsumptionHistory)
      ? (r.doseConsumptionHistory as Record<string, string[]>)
      : undefined;

  const doseSkippedHistory =
    r.doseSkippedHistory && typeof r.doseSkippedHistory === 'object' && !Array.isArray(r.doseSkippedHistory)
      ? (r.doseSkippedHistory as Record<string, string[]>)
      : undefined;

  const candidate: Medication = {
    id,
    name,
    currentPills,
    dailyDose,
    unit,
    warningThresholdDays,
    colorTag,
    createdAt,
    category,
    notes,
    autoDeductEnabled,
    isChronic,
    durationDays,
    treatmentStartDate,
    packageSize,
    stripsPerBox,
    pillsPerStrip,
    targetOrderQuantity,
    reminderEnabled,
    reminderTime,
    criticalStockAlertsEnabled,
    dosesPerDay,
    doseSchedule,
    lastConsumedDate,
    doseConsumptionHistory,
    doseSkippedHistory,
  };

  if (isValidMedicationRecord(candidate)) {
    return candidate;
  }

  return null;
}

/**
 * Validates and normalizes pharmacy settings, contacts, and addresses to protect
 * runtime integrity and prevent any malicious or corrupt values from causing errors.
 */
export function normalizePharmacySettingsForImport(raw: unknown): PharmacySettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;

  const defaultDurationDays: 30 | 60 = p.defaultDurationDays === 60 ? 60 : 30;

  const pharmacies: Pharmacy[] = [];
  if (Array.isArray(p.pharmacies)) {
    for (const item of p.pharmacies) {
      if (item && typeof item === 'object') {
        const ph = item as Record<string, unknown>;
        if (typeof ph.name === 'string' && ph.name.trim()) {
          pharmacies.push({
            id: typeof ph.id === 'string' && ph.id.trim() ? ph.id.trim() : generateId('pharm'),
            name: ph.name.trim(),
            phone: typeof ph.phone === 'string' ? ph.phone.trim() : '',
            customerCode: typeof ph.customerCode === 'string' ? ph.customerCode.trim() : '',
          });
        }
      }
    }
  }

  const whatsappContacts: UserContact[] = [];
  if (Array.isArray(p.whatsappContacts)) {
    for (const item of p.whatsappContacts) {
      if (item && typeof item === 'object') {
        const c = item as Record<string, unknown>;
        if (typeof c.label === 'string' && c.label.trim()) {
          whatsappContacts.push({
            id: typeof c.id === 'string' && c.id.trim() ? c.id.trim() : generateId('contact'),
            label: c.label.trim(),
            phone: typeof c.phone === 'string' ? c.phone.trim() : '',
          });
        }
      }
    }
  }

  const whatsappAddresses: UserAddress[] = [];
  if (Array.isArray(p.whatsappAddresses)) {
    for (const item of p.whatsappAddresses) {
      if (item && typeof item === 'object') {
        const a = item as Record<string, unknown>;
        if (typeof a.label === 'string' && a.label.trim()) {
          whatsappAddresses.push({
            id: typeof a.id === 'string' && a.id.trim() ? a.id.trim() : generateId('address'),
            label: a.label.trim(),
            address: typeof a.address === 'string' ? a.address.trim() : '',
          });
        }
      }
    }
  }

  const selectedPharmacyId =
    typeof p.selectedPharmacyId === 'string' ? p.selectedPharmacyId.trim() : '';

  const selectedWhatsappContactIds = Array.isArray(p.selectedWhatsappContactIds)
    ? p.selectedWhatsappContactIds.filter((id): id is string => typeof id === 'string')
    : [];

  const selectedWhatsappAddressIds = Array.isArray(p.selectedWhatsappAddressIds)
    ? p.selectedWhatsappAddressIds.filter((id): id is string => typeof id === 'string')
    : [];

  return {
    defaultDurationDays,
    pharmacies,
    selectedPharmacyId,
    whatsappContacts,
    whatsappAddresses,
    selectedWhatsappContactIds,
    selectedWhatsappAddressIds,
  };
}

/**
 * Validates and parses raw backup JSON text (envelope or array).
 * Performs thorough validation to protect against malformed, malicious or crashing data.
 */
export function parseAndValidateBackupFile(jsonText: string): BackupValidationResult {
  if (!jsonText || !jsonText.trim()) {
    return { ok: false, error: 'الملف فارغ، يرجى اختيار ملف نسخة احتياطية صحيح.' };
  }

  // Guard against massive payloads that could lock up the browser memory
  if (jsonText.length > 10 * 1024 * 1024) {
    return { ok: false, error: 'حجم الملف كبير جداً ويتجاوز الحد المسموح به (10 ميجابايت).' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'الملف تالف أو غير صالح (صيغة JSON غير صحيحة).' };
  }

  if (!raw || (typeof raw !== 'object' && !Array.isArray(raw))) {
    return { ok: false, error: 'هيكل بيانات النسخة الاحتياطية غير متطابق مع نسق التطبيق.' };
  }

  let candidateMeds: unknown[] = [];
  let candidateLogs: unknown[] = [];
  let rawPharmacySettings: unknown = undefined;
  let exportedAt: string | undefined;
  let scope: BackupScope | undefined;

  if (Array.isArray(raw)) {
    // Direct array of medications
    candidateMeds = raw;
    scope = 'medications';
  } else {
    // Envelope object
    const envelope = raw as Record<string, unknown>;

    // If envelope declares an app name and it's not drug-tracker, verify compatibility
    if (envelope.app !== undefined && envelope.app !== 'drug-tracker') {
      return { ok: false, error: 'هذا الملف غير مخصص لتطبيق منظم الأدوية.' };
    }

    if (envelope.scope === 'medications' || envelope.scope === 'all') {
      scope = envelope.scope;
    }

    if (Array.isArray(envelope.medications)) {
      candidateMeds = envelope.medications;
    } else if (Array.isArray(envelope.items)) {
      candidateMeds = envelope.items;
    }

    if (Array.isArray(envelope.logs)) {
      candidateLogs = envelope.logs;
    }

    if (envelope.pharmacySettings && typeof envelope.pharmacySettings === 'object') {
      rawPharmacySettings = envelope.pharmacySettings;
    }

    if (typeof envelope.exportedAt === 'string') {
      exportedAt = envelope.exportedAt;
    }
  }

  const rawCount = candidateMeds.length;
  if (rawCount === 0) {
    return { ok: false, error: 'لم يتم العثور على أدوية داخل هذا الملف.' };
  }

  const validMeds: Medication[] = [];
  for (const item of candidateMeds) {
    const med = normalizeMedicationForImport(item);
    if (med) {
      validMeds.push(med);
    }
  }

  if (validMeds.length === 0) {
    return {
      ok: false,
      error: 'تعذر التعرف على بيانات الأدوية داخل الملف. تأكد من أن الملف سليم وصادر من التطبيق.',
    };
  }

  // Parse and validate logs if present
  const validLogs: ConsumptionLog[] = [];
  for (const logItem of candidateLogs) {
    if (isValidConsumptionLogRecord(logItem)) {
      validLogs.push(logItem);
    }
  }

  // Parse and sanitize pharmacy settings if present
  const validatedPharmacySettings = normalizePharmacySettingsForImport(rawPharmacySettings);

  return {
    ok: true,
    data: {
      scope,
      exportedAt,
      medications: validMeds,
      logs: validLogs,
      pharmacySettings: validatedPharmacySettings,
      rawCount,
      validCount: validMeds.length,
    },
  };
}
