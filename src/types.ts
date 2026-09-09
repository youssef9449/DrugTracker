export interface ConsumptionLog {
  id: string;
  medicationId: string;
  medicationName: string;
  type: 'auto_daily' | 'refill' | 'manual_adjust' | 'skipped_day' | 'dose_taken';
  amount: number; // positive or negative
  date: string; // YYYY-MM-DD
  timestamp: string;
  description: string;
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
 * Formats 24-hour time "HH:mm" into friendly Arabic 12-hour format e.g. "9:00 ص" or "9:30 م"
 */
export function formatTimeArabic(timeStr?: string): string {
  if (!timeStr) return '';
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const isPM = h >= 12;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minutePadded = m < 10 ? `0${m}` : `${m}`;
  return `${hour12}:${minutePadded} ${isPM ? 'م' : 'ص'}`;
}

/**
 * Returns human-readable strip and pill breakdown of current inventory.
 * e.g., 35 pills with 10 pills/strip and 3 strips/box -> "علبة واحدة و 5 أقراص"
 * or 25 pills with 10 pills/strip -> "شريطان و 5 أقراص"
 */
export function describeStockInStrips(
  pills: number,
  pillsPerStrip?: number,
  stripsPerBox?: number,
  unit: string = 'قرص'
): string | null {
  if (!pillsPerStrip || pillsPerStrip <= 0 || pills <= 0) return null;

  const totalStrips = Math.floor(pills / pillsPerStrip);
  const remainingPills = Math.round(pills % pillsPerStrip);

  const pillWord =
    remainingPills === 1 ? `${unit} واحد` : remainingPills === 2 ? `2 ${unit}` : `${remainingPills} ${unit}`;

  // If strips per box is defined, break down into boxes + strips + pills
  if (stripsPerBox && stripsPerBox > 0) {
    const boxes = Math.floor(totalStrips / stripsPerBox);
    const strips = totalStrips % stripsPerBox;

    const boxWord =
      boxes === 1 ? 'علبة واحدة' : boxes === 2 ? 'علبتان' : boxes <= 10 ? `${boxes} علب` : `${boxes} علبة`;
    const stripWord =
      strips === 1 ? 'شريط واحد' : strips === 2 ? 'شريطان' : strips <= 10 ? `${strips} أشرطة` : `${strips} شريطاً`;

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
  const stripWord =
    totalStrips === 1 ? 'شريط واحد' : totalStrips === 2 ? 'شريطان' : totalStrips <= 10 ? `${totalStrips} أشرطة` : `${totalStrips} شريطاً`;

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
 */
export function describeOrderInBoxes(
  targetPills: number,
  stripsPerBox?: number,
  pillsPerStrip?: number,
  packageSize?: number,
  unit: string = 'قرص'
): string {
  const boxSize =
    stripsPerBox && pillsPerStrip && stripsPerBox > 0 && pillsPerStrip > 0
      ? stripsPerBox * pillsPerStrip
      : packageSize && packageSize > 0
      ? packageSize
      : 30;

  const stripSize = pillsPerStrip && pillsPerStrip > 0 ? pillsPerStrip : null;

  const boxes = Math.floor(targetPills / boxSize);
  const remainderAfterBoxes = targetPills % boxSize;

  const boxWord =
    boxes === 1 ? 'علبة واحدة' : boxes === 2 ? 'علبتان' : boxes <= 10 ? `${boxes} علب` : `${boxes} علبة`;

  if (boxes > 0 && remainderAfterBoxes === 0) {
    return `${boxWord} (${targetPills} ${unit})`;
  }

  if (stripSize && remainderAfterBoxes > 0) {
    const strips = Math.floor(remainderAfterBoxes / stripSize);
    const loosePills = remainderAfterBoxes % stripSize;

    const stripWord =
      strips === 1 ? 'شريط' : strips === 2 ? 'شريطان' : `${strips} أشرطة`;

    if (boxes > 0 && strips > 0 && loosePills === 0) {
      return `${boxWord} و ${stripWord} (${targetPills} ${unit})`;
    }
    if (boxes === 0 && strips > 0 && loosePills === 0) {
      return `${stripWord} (${targetPills} ${unit})`;
    }
  }

  if (boxes > 0) {
    return `${boxWord} تقريباً (${targetPills} ${unit})`;
  }

  return `${targetPills} ${unit}`;
}

export interface PharmacySettings {
  pharmacyPhone: string; // e.g., "01012345678"
  pharmacyName: string; // e.g., "صيدلية الإسعاف"
  customerCode: string; // "14739" as requested
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
}

export const DEFAULT_PHARMACY_SETTINGS: PharmacySettings = {
  pharmacyPhone: '',
  pharmacyName: 'الصيدلية',
  customerCode: '',
  defaultDurationDays: 30,
  customQuantities: {},
  address: '',
  contactPhone: '',
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
  if (med.currentPills <= 0) {
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

  const daysLeft = Math.floor(med.currentPills / med.dailyDose);
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
