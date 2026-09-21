import { Medication, isSolidUnit, describeStockInStrips } from '../types';
import { DEFAULT_LIQUID_PACK_SIZE, DEFAULT_SOLID_PACK_SIZE, DAYS_PER_MONTH } from './time';
import { pluralizeArabic } from '../lib/arabicPlural';
import { dailyScheduleAmount } from './dateCalculations';

/**
 * Shared medication-packaging helpers (audit #73).
 *
 * `getMedSizes` was byte-identical across RefillModal.tsx and
 * PharmacyShoppingView.tsx. Extracted here as the single source of truth.
 *
 * Note: the two components' `getAvailableUnits` functions are NOT
 * semantically equivalent (RefillModal seeds ['pills'], PharmacyShoppingView
 * seeds ['boxes']) — they remain local to each component.
 */

export interface MedSizes {
  /** Pills per box (stripsPerBox * pillsPerStrip, or packageSize, or a unit-based default). */
  boxSize: number;
  /** Pills per strip (0 when the med has no strips). */
  stripSize: number;
  /** Whether the med has a valid strips-per-box × pills-per-strip configuration. */
  hasStrips: boolean;
  /** Whether the unit is a solid (pill/capsule) — via isSolidUnit (#72). */
  isSolid: boolean;
}

/**
 * Compute the packaging constants for a medication.
 *
 * - `boxSize`: stripsPerBox × pillsPerStrip when both are defined and
 *   positive; otherwise the packageSize if defined; otherwise a unit-based
 *   default (100 for 'مل', 30 otherwise).
 * - `stripSize`: pillsPerStrip when the med has strips, else 0.
 * - `hasStrips`: true only for solid units with valid strips×pills config.
 *
 * This replaces the previous `med.stripsPerBox! * med.pillsPerStrip!`
 * non-null-assertion pattern with proper narrowing (audit #98).
 */
export function getMedSizes(med: Medication): MedSizes {
  const isSolid = isSolidUnit(med.unit);
  const stripsPerBox = med.stripsPerBox;
  const pillsPerStrip = med.pillsPerStrip;
  const hasStrips =
    isSolid &&
    Boolean(
      stripsPerBox && pillsPerStrip && stripsPerBox > 0 && pillsPerStrip > 0
    );
  const boxSize = hasStrips && stripsPerBox && pillsPerStrip
    ? stripsPerBox * pillsPerStrip
    : med.packageSize && med.packageSize > 0
    ? med.packageSize
    : med.unit === 'مل'
    ? DEFAULT_LIQUID_PACK_SIZE
    : DEFAULT_SOLID_PACK_SIZE;
  const stripSize =
    hasStrips && pillsPerStrip && pillsPerStrip > 0 ? pillsPerStrip : 0;
  return { boxSize, stripSize, hasStrips, isSolid };
}

/**
 * Formats the daily or monthly scheduled dose consumption for a medication.
 * Aggregates solid units into boxes and strips using `describeStockInStrips`,
 * displaying remaining pills/capsules/strips when present, for both views.
 */
export function formatScheduledDoseBreakdown(
  med: Medication,
  isDaily: boolean
): string {
  const hasSchedule = Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0;
  const slots = hasSchedule ? med.doseSchedule!.length : 0;
  if (slots <= 0) {
    return '0 جرعة';
  }

  const dailyAmt = dailyScheduleAmount(med);
  const effectiveDailyUnits = dailyAmt > 0 ? dailyAmt : slots;
  const totalUnits = isDaily ? effectiveDailyUnits : effectiveDailyUnits * DAYS_PER_MONTH;

  const unit = med.unit || 'قرص';
  const isSolid = isSolidUnit(unit);

  if (isSolid) {
    // 1. If strip configuration exists, use describeStockInStrips helper
    // to aggregate into: boxes + strips + remaining pills/capsules
    if (med.pillsPerStrip && med.pillsPerStrip > 0) {
      const breakdown = describeStockInStrips(
        totalUnits,
        med.pillsPerStrip,
        med.stripsPerBox,
        unit
      );
      if (breakdown) {
        return breakdown;
      }
    }

    // 2. Solid medication without strips (e.g., bottle with packageSize)
    if (med.packageSize && med.packageSize > 0) {
      const boxes = Math.floor(totalUnits / med.packageSize);
      const rem = Math.round(totalUnits % med.packageSize);
      const parts: string[] = [];
      if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
      if (rem > 0) parts.push(pluralizeArabic(rem, unit));
      if (parts.length > 0) {
        return parts.join(' و ');
      }
    }

    return pluralizeArabic(totalUnits, unit);
  }

  // Sachet (كيس):
  if (unit === 'كيس') {
    const pkgSize = med.packageSize && med.packageSize > 0 ? med.packageSize : 10;
    const boxes = Math.floor(totalUnits / pkgSize);
    const rem = Math.round(totalUnits % pkgSize);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (rem > 0) parts.push(pluralizeArabic(rem, 'كيس'));
    return parts.length > 0 ? parts.join(' و ') : pluralizeArabic(totalUnits, 'كيس');
  }

  // Dose (جرعة):
  if (unit === 'جرعة') {
    const pkgSize = med.packageSize && med.packageSize > 0 ? med.packageSize : 30;
    const boxes = Math.floor(totalUnits / pkgSize);
    const rem = Math.round(totalUnits % pkgSize);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (rem > 0) parts.push(pluralizeArabic(rem, 'جرعة'));
    return parts.length > 0 ? parts.join(' و ') : pluralizeArabic(totalUnits, 'جرعة');
  }

  // Liquid (مل):
  if (unit === 'مل') {
    const pkgSize = med.packageSize && med.packageSize > 0 ? med.packageSize : DEFAULT_LIQUID_PACK_SIZE;
    const bottles = Math.floor(totalUnits / pkgSize);
    const rem = totalUnits % pkgSize;
    const parts: string[] = [];
    if (bottles > 0) parts.push(pluralizeArabic(bottles, 'عبوة'));
    if (rem > 0) parts.push(pluralizeArabic(rem, 'مل'));
    return parts.length > 0 ? parts.join(' و ') : pluralizeArabic(totalUnits, 'مل');
  }

  // Any other unit:
  if (med.packageSize && med.packageSize > 0) {
    const boxes = Math.floor(totalUnits / med.packageSize);
    const rem = Math.round(totalUnits % med.packageSize);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (rem > 0) parts.push(pluralizeArabic(rem, unit));
    if (parts.length > 0) return parts.join(' و ');
  }

  return pluralizeArabic(totalUnits, unit);
}

