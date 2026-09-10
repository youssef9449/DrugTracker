import { pluralizeArabic } from './lib/arabicPlural';
import { effectiveCurrentPills, effectiveDaysLeft } from './utils/dateCalculations';

export interface ConsumptionLog {
  id: string;
  medicationId: string;
  medicationName: string;
  type: 'auto_daily' | 'refill' | 'refill_undo' | 'manual_adjust' | 'skipped_day' | 'dose_taken';
  amount: number; // positive or negative
  date: string; // YYYY-MM-DD
  timestamp: string;
  description: string;
  /** Set when this refill has already been reversed. Legacy logs omit it. */
  reversedAt?: string;
  /** Links a refill_undo log to the original refill log. */
  relatedLogId?: string;
}

export type NotificationSoundType =
  | 'gentle_bell'
  | 'marimba'
  | 'digital_beep'
  | 'harp'
  | 'radar'
  | 'classic_chime'
  | 'custom';

/**
 * Identifier for a user-uploaded custom sound file. We store only the file
 * name (for display) and the data URL (for playback). The data URL is
 * generated via URL.createObjectURL or FileReader.readAsDataURL on the
 * client, then persisted in localStorage so the custom sound survives
 * page reloads without re-uploading the file.
 */
export interface CustomSoundFile {
  /** Original file name as selected by the user (for display only). */
  fileName: string;
  /** MIME type (e.g., 'audio/mpeg', 'audio/wav', 'audio/ogg'). */
  mimeType: string;
  /** Base64 data URL of the audio file content. */
  dataUrl: string;
}

export interface Medication {
  id: string;
  name: string;
  currentPills: number;
  dailyDose: number; // Consumption rate per day
  unit: string; // e.g., 'قرص', 'كبسولة', 'مل'
  warningThresholdDays: number; // Alert when days left <= this number (default 5)
  colorTag: string;
  category?: string;
  notes?: string;
  createdAt: string;
  lastSyncDate: string; // YYYY-MM-DD: date when currentPills was synced/counted
  autoDeductEnabled?: boolean; // Default true
  packageSize?: number; // Size of standard package when bought (e.g. 30)
  stripsPerBox?: number; // عدد الأشرطة في العلبة (مثال: 3 أشرطة)
  pillsPerStrip?: number; // عدد الأقراص في الشريط الواحد (مثال: 10 أقراص)
  targetOrderQuantity?: number; // Custom target order quantity specified for pharmacy order
  reminderEnabled?: boolean; // هل تم تفعيل تذكير يومي بموعد محدد
  reminderTime?: string; // وقت التذكير بصيغة 24 ساعة (مثال: "09:00" أو "21:30")
  notificationSound?: NotificationSoundType; // نغمة تنبيه مخصصة لهذا الدواء (synthesized tones فقط)
  /** YYYY-MM-DD of the last day the user manually consumed a dose.
   * When this equals today, syncAutoDailyDeductions skips the auto-
   * deduction for this med (the user already took the dose manually)
   * and the card shows a "تم تناول جرعة اليوم" badge. */
  lastConsumedDate?: string;
}

/**
 * Critical-stock threshold (in days), derived from the medication's
 * `warningThresholdDays`.
 *
 * The "warning" status fires when `daysLeft <= warningThresholdDays`.
 * The "critical" status is a more urgent subset that fires at half the
 * warning window (floored to at least 1 day), so the critical level
 * scales with the user-configured warning window instead of being a
 * fixed 2-day constant.
 *
 * Examples:
 *   warningThresholdDays = 5  -> criticalThresholdDays = 2
 *   warningThresholdDays = 7  -> criticalThresholdDays = 3
 *   warningThresholdDays = 10 -> criticalThresholdDays = 5
 *   warningThresholdDays = 1  -> criticalThresholdDays = 1
 */
export function getCriticalThresholdDays(med: Medication): number {
  return Math.max(1, Math.floor((med.warningThresholdDays || 5) / 2));
}

/**
 * Returns true when the unit represents a solid medication (pill or
 * capsule) — i.e. one that is packaged in strips/boxes. Liquid units
 * (e.g. 'مل') and anything else return false.
 *
 * Centralizes the `unit === 'قرص' || unit === 'كبسولة'` predicate that
 * was duplicated 12× across the codebase (audit #72).
 */
export function isSolidUnit(unit: string): boolean {
  return unit === 'قرص' || unit === 'كبسولة';
}

/**
 * Formats 24-hour time "HH:mm" into friendly Arabic 12-hour format,
 * e.g. "9:00 ص" or "9:30 م".
 *
 * Strictly validates the input shape `^H?H:MM$` with hour 0–23 and
 * minute 0–59. Returns the raw string unchanged if invalid so callers
 * can detect a malformed `reminderTime` (the reminder scheduler's own
 * `timeToMinutes` validator would then reject it too, skipping the
 * alarm rather than firing it for a garbage time).
 */
export function formatTimeArabic(timeStr?: string): string {
  if (!timeStr) return '';
  // Strict shape: one or two digit hour, colon, exactly two digit minute.
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeStr);
  if (!match) return timeStr;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return timeStr;
  const isPM = h >= 12;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minutePadded = m < 10 ? `0${m}` : `${m}`;
  return `${hour12}:${minutePadded} ${isPM ? 'م' : 'ص'}`;
}

/**
 * Returns human-readable strip and pill breakdown of current inventory.
 * e.g., 35 pills with 10 pills/strip and 3 strips/box -> "علبة واحدة و 5 أقراص"
 * or 25 pills with 10 pills/strip -> "شريطان و 5 أقراص"
 *
 * Uses `pluralizeArabic` for correct Arabic noun forms per count
 * (singular / dual / few 3-10 / many 11+).
 */
export function describeStockInStrips(
  pills: number,
  pillsPerStrip?: number,
  stripsPerBox?: number,
  unit: string = 'قرص'
): string | null {
  // Strips only apply to solid medications (pills/capsules)
  if (!isSolidUnit(unit)) return null;
  if (!pillsPerStrip || pillsPerStrip <= 0 || pills <= 0) return null;

  const totalStrips = Math.floor(pills / pillsPerStrip);
  const remainingPills = Math.round(pills % pillsPerStrip);

  const pillWord = pluralizeArabic(remainingPills, unit);

  // If strips per box is defined, break down into boxes + strips + pills
  if (stripsPerBox && stripsPerBox > 0) {
    const boxes = Math.floor(totalStrips / stripsPerBox);
    const strips = totalStrips % stripsPerBox;

    const boxWord = pluralizeArabic(boxes, 'علبة');
    const stripWord = pluralizeArabic(strips, 'شريط');

    const parts: string[] = [];
    if (boxes > 0) parts.push(boxWord);
    if (strips > 0) parts.push(stripWord);
    if (remainingPills > 0) parts.push(pillWord);

    if (parts.length > 0) {
      return parts.join(' و ');
    }
    return null;
  }

  // If only pillsPerStrip is known
  const stripWord = pluralizeArabic(totalStrips, 'شريط');

  if (totalStrips > 0 && remainingPills > 0) {
    return `${stripWord} و ${pillWord}`;
  } else if (totalStrips > 0) {
    return stripWord;
  } else if (remainingPills > 0) {
    return pillWord;
  }
  return null;
}

/**
 * Returns packaging breakdown for pharmacy ordering (e.g., "2 علبة (60 قرص)" or "1 علبة و 1 شريط").
 *
 * Uses `pluralizeArabic` for correct Arabic noun forms.
 */
export function describeOrderInBoxes(
  targetPills: number,
  stripsPerBox?: number,
  pillsPerStrip?: number,
  packageSize?: number,
  unit: string = 'قرص'
): string {
  const isSolid = isSolidUnit(unit);
  const effectiveStripsPerBox = isSolid ? stripsPerBox : undefined;
  const effectivePillsPerStrip = isSolid ? pillsPerStrip : undefined;
  const boxWordLabel = unit === 'مل' ? 'عبوة' : 'علبة';

  const boxSize =
    effectiveStripsPerBox && effectivePillsPerStrip && effectiveStripsPerBox > 0 && effectivePillsPerStrip > 0
      ? effectiveStripsPerBox * effectivePillsPerStrip
      : packageSize && packageSize > 0
      ? packageSize
      : unit === 'مل' ? 100 : 30;

  const stripSize = effectivePillsPerStrip && effectivePillsPerStrip > 0 ? effectivePillsPerStrip : null;

  const boxes = Math.floor(targetPills / boxSize);
  const remainderAfterBoxes = targetPills % boxSize;

  const pillTotalWord = pluralizeArabic(targetPills, unit);

  // Exact match — full boxes only.
  if (boxes > 0 && remainderAfterBoxes === 0) {
    const boxWord = pluralizeArabic(boxes, boxWordLabel);
    return `${boxWord} (${pillTotalWord})`;
  }

  // Boxes + strips (and possibly loose pills) for solid medications.
  if (boxes > 0 && stripSize && remainderAfterBoxes > 0) {
    const strips = Math.floor(remainderAfterBoxes / stripSize);
    const loosePills = remainderAfterBoxes % stripSize;
    const boxWord = pluralizeArabic(boxes, boxWordLabel);
    const parts: string[] = [boxWord];
    if (strips > 0) parts.push(pluralizeArabic(strips, 'شريط'));
    if (loosePills > 0) parts.push(pluralizeArabic(loosePills, unit));
    return `${parts.join(' و ')} (${pillTotalWord})`;
  }

  // Boxes + remainder with no strips (e.g. liquid bottles or loose units)
  if (boxes > 0 && !stripSize && remainderAfterBoxes > 0) {
    const boxWord = pluralizeArabic(boxes, boxWordLabel);
    const looseWord = pluralizeArabic(remainderAfterBoxes, unit);
    return `${boxWord} و ${looseWord} (${pillTotalWord})`;
  }

  // Strips only (no boxes), possibly + loose pills.
  if (boxes === 0 && stripSize && remainderAfterBoxes > 0) {
    const strips = Math.floor(remainderAfterBoxes / stripSize);
    const loosePills = remainderAfterBoxes % stripSize;
    if (strips > 0) {
      const parts: string[] = [pluralizeArabic(strips, 'شريط')];
      if (loosePills > 0) parts.push(pluralizeArabic(loosePills, unit));
      return `${parts.join(' و ')} (${pillTotalWord})`;
    }
  }

  // No boxes, no strips — just the total count in unit.
  return pillTotalWord;
}

export interface Pharmacy {
  id: string;
  name: string;
  phone: string;
  customerCode: string;
}

export interface PharmacySettings {
  pharmacyPhone: string; // e.g., "01012345678"
  pharmacyName: string; // e.g., "صيدلية الإسعاف"
  customerCode: string; // customer code at the pharmacy (optional)
  defaultDurationDays: 30 | 60;
  customQuantities: Record<string, number>; // medId -> custom quantity
  /**
   * Customer's delivery address — included in the WhatsApp order
   * message so the pharmacy knows where to deliver.
   */
  address: string;
  /**
   * Customer's contact phone number — included in the WhatsApp
   * order message so the pharmacy can call back to confirm.
   */
  contactPhone: string;
  pharmacies?: Pharmacy[];
  selectedPharmacyId?: string;
}

export const DEFAULT_PHARMACY_SETTINGS: PharmacySettings = {
  pharmacyPhone: '',
  pharmacyName: '',
  customerCode: '',
  defaultDurationDays: 30,
  customQuantities: {},
  address: '',
  contactPhone: '',
  pharmacies: [],
  selectedPharmacyId: '',
};

export type MedicationStatus = 'out_of_stock' | 'critical' | 'warning' | 'sufficient';

export function calculateMedicationStatus(med: Medication): {
  daysLeft: number;
  status: MedicationStatus;
  statusLabel: string;
  statusColorClass: string;
  badgeBg: string;
  badgeText: string;
} {
  // The dynamic balance: projects currentPills forward from lastSyncDate
  // by dailyDose. This keeps status correct even if the app was closed
  // for many days and syncAutoDailyDeductions hasn't run yet.
  const effPills = effectiveCurrentPills(med);
  const daysLeft = effectiveDaysLeft(med);

  if (effPills <= 0) {
    return {
      daysLeft: 0,
      status: 'out_of_stock',
      statusLabel: 'نفد تماماً',
      statusColorClass: 'text-red-600',
      badgeBg: 'bg-red-50 text-red-700 border-red-200',
      badgeText: '⚠️ نفد المخزون',
    };
  }

  if (med.dailyDose <= 0) {
    return {
      daysLeft: 999,
      status: 'sufficient',
      statusLabel: 'غير محدد',
      statusColorClass: 'text-slate-600',
      badgeBg: 'bg-slate-100 text-slate-700 border-slate-200',
      badgeText: 'استهلاك غير محدد',
    };
  }

  const criticalThresholdDays = getCriticalThresholdDays(med);

  if (daysLeft <= criticalThresholdDays) {
    const daysWord =
      daysLeft === 1 ? 'يوم واحد' : daysLeft === 2 ? 'يومين' : `${daysLeft} أيام`;
    return {
      daysLeft,
      status: 'critical',
      statusLabel: `حرج (${daysWord})`,
      statusColorClass: 'text-rose-600',
      badgeBg: 'bg-rose-50 text-rose-700 border-rose-200',
      badgeText: `🚨 باقي ${daysLeft === 1 ? 'يوم فقط' : `${daysLeft} أيام`}`,
    };
  }

  if (daysLeft <= med.warningThresholdDays) {
    return {
      daysLeft,
      status: 'warning',
      statusLabel: `اقترب من النفاذ (${daysLeft} أيام)`,
      statusColorClass: 'text-amber-600',
      badgeBg: 'bg-amber-50 text-amber-700 border-amber-200',
      badgeText: `⚠️ يكفي لـ ${daysLeft} أيام فقط`,
    };
  }

  return {
    daysLeft,
    status: 'sufficient',
    statusLabel: `كافٍ (${daysLeft} يوماً)`,
    statusColorClass: 'text-emerald-600',
    badgeBg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    badgeText: `✅ يكفي لـ ${daysLeft} يوماً`,
  };
}
