import type { Medication } from '../types';
import { DEFAULT_LIQUID_PACK_SIZE, DEFAULT_SOLID_PACK_SIZE, DAYS_PER_MONTH } from './time';
import { pluralizeArabic } from '../lib/arabicPlural';
import { dailyScheduleAmount } from './dateCalculations';

export function isSolidUnit(unit: string): boolean {
  return unit === 'قرص' || unit === 'كبسولة';
}

export function normalizeDisplayQuantity(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const nearest = Math.round(value);
  const scale = Math.max(Math.abs(value), Math.abs(nearest), 1);
  const intEps = Number.EPSILON * scale * 8;
  if (Math.abs(value - nearest) <= intEps) return nearest;

  const abs = Math.abs(value);
  if (abs === 0) return 0;

  const exp2 = Math.floor(Math.log2(abs));
  const ulp = Math.pow(2, exp2 - 52);
  for (let places = 1; places <= 17; places++) {
    const factor = 10 ** places;
    const candidate = Math.round(value * factor) / factor;
    if (Math.abs(value - candidate) <= ulp) return candidate;
  }

  return value;
}

export function formatUnitQuantity(value: number, unit: string): string {
  const normalized = normalizeDisplayQuantity(value);
  if (Number.isInteger(normalized)) {
    return pluralizeArabic(normalized, unit);
  }
  return `${normalized} ${unit}`;
}

export function describeStockInStrips(
  pills: number,
  pillsPerStrip?: number,
  stripsPerBox?: number,
  unit: string = 'قرص'
): string | null {
  if (!isSolidUnit(unit)) return null;
  if (!pillsPerStrip || pillsPerStrip <= 0 || pills <= 0) return null;

  const totalStrips = Math.floor(pills / pillsPerStrip);
  const remainingPills = normalizeDisplayQuantity(
    pills - totalStrips * pillsPerStrip
  );
  const pillWord = formatUnitQuantity(remainingPills, unit);

  if (stripsPerBox && stripsPerBox > 0) {
    const boxes = Math.floor(totalStrips / stripsPerBox);
    const strips = totalStrips % stripsPerBox;

    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (strips > 0) parts.push(pluralizeArabic(strips, 'شريط'));
    if (remainingPills > 0) parts.push(pillWord);

    return parts.length > 0 ? parts.join(' و ') : null;
  }

  const stripWord = pluralizeArabic(totalStrips, 'شريط');
  if (totalStrips > 0 && remainingPills > 0) {
    return `${stripWord} و ${pillWord}`;
  }
  if (totalStrips > 0) return stripWord;
  if (remainingPills > 0) return pillWord;
  return null;
}

export function describeOrderInBoxes(
  targetPills: number,
  stripsPerBox?: number,
  pillsPerStrip?: number,
  packageSize?: number,
  unit: string = 'قرص'
): string {
  const solid = isSolidUnit(unit);
  const effectiveStripsPerBox = solid ? stripsPerBox : undefined;
  const effectivePillsPerStrip = solid ? pillsPerStrip : undefined;
  const boxWordLabel = unit === 'مل' ? 'عبوة' : 'علبة';

  const boxSize =
    effectiveStripsPerBox &&
    effectivePillsPerStrip &&
    effectiveStripsPerBox > 0 &&
    effectivePillsPerStrip > 0
      ? effectiveStripsPerBox * effectivePillsPerStrip
      : packageSize && packageSize > 0
        ? packageSize
        : unit === 'مل'
          ? 100
          : 30;

  const stripSize =
    effectivePillsPerStrip && effectivePillsPerStrip > 0
      ? effectivePillsPerStrip
      : null;

  const boxes = Math.floor(targetPills / boxSize);
  const remainderAfterBoxes = targetPills % boxSize;
  const pillTotalWord = pluralizeArabic(targetPills, unit);

  if (boxes > 0 && remainderAfterBoxes === 0) {
    return pluralizeArabic(boxes, boxWordLabel);
  }

  if (boxes > 0 && stripSize && remainderAfterBoxes > 0) {
    const strips = Math.floor(remainderAfterBoxes / stripSize);
    const loosePills = remainderAfterBoxes % stripSize;
    const parts: string[] = [pluralizeArabic(boxes, boxWordLabel)];
    if (strips > 0) parts.push(pluralizeArabic(strips, 'شريط'));
    if (loosePills > 0) {
      parts.push(pluralizeArabic(Math.ceil(loosePills / stripSize), 'شريط'));
    }
    return parts.join(' و ');
  }

  if (boxes > 0 && !stripSize && remainderAfterBoxes > 0) {
    if (solid) {
      return pluralizeArabic(boxes + 1, boxWordLabel);
    }
    return `${pluralizeArabic(boxes, boxWordLabel)} و ${pluralizeArabic(
      remainderAfterBoxes,
      unit
    )}`;
  }

  if (boxes === 0 && stripSize && remainderAfterBoxes > 0) {
    return pluralizeArabic(
      Math.ceil(remainderAfterBoxes / stripSize),
      'شريط'
    );
  }

  if (boxes === 0 && !stripSize && solid && targetPills > 0) {
    return pluralizeArabic(1, boxWordLabel);
  }

  return pillTotalWord;
}

export interface MedSizes {
  /** Pills per box. */
  boxSize: number;
  /** Pills per strip (0 when strips are not configured). */
  stripSize: number;
  /** Whether a valid strips-per-box × pills-per-strip configuration exists. */
  hasStrips: boolean;
  /** Whether the medication uses a solid unit. */
  isSolid: boolean;
}

export function getMedSizes(med: Medication): MedSizes {
  const isSolid = isSolidUnit(med.unit);
  const stripsPerBox = med.stripsPerBox;
  const pillsPerStrip = med.pillsPerStrip;
  const hasStrips =
    isSolid &&
    Boolean(
      stripsPerBox &&
        pillsPerStrip &&
        stripsPerBox > 0 &&
        pillsPerStrip > 0
    );

  const boxSize =
    hasStrips && stripsPerBox && pillsPerStrip
      ? stripsPerBox * pillsPerStrip
      : med.packageSize && med.packageSize > 0
        ? med.packageSize
        : med.unit === 'مل'
          ? DEFAULT_LIQUID_PACK_SIZE
          : DEFAULT_SOLID_PACK_SIZE;

  const stripSize =
    hasStrips && pillsPerStrip && pillsPerStrip > 0
      ? pillsPerStrip
      : 0;

  return { boxSize, stripSize, hasStrips, isSolid };
}

export function formatScheduledDoseBreakdown(
  med: Medication,
  isDaily: boolean
): string {
  const hasSchedule =
    Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0;
  const slots = hasSchedule ? med.doseSchedule!.length : 0;
  if (slots <= 0) return '0 جرعة';

  const dailyAmt = dailyScheduleAmount(med);
  const effectiveDailyUnits = dailyAmt > 0 ? dailyAmt : slots;
  const totalUnits = isDaily
    ? effectiveDailyUnits
    : effectiveDailyUnits * DAYS_PER_MONTH;

  const unit = med.unit || 'قرص';

  if (isSolidUnit(unit)) {
    if (med.pillsPerStrip && med.pillsPerStrip > 0) {
      const breakdown = describeStockInStrips(
        totalUnits,
        med.pillsPerStrip,
        med.stripsPerBox,
        unit
      );
      if (breakdown) return breakdown;
    }

    if (med.packageSize && med.packageSize > 0) {
      const boxes = Math.floor(totalUnits / med.packageSize);
      const rem = normalizeDisplayQuantity(totalUnits % med.packageSize);
      const parts: string[] = [];
      if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
      if (rem > 0) parts.push(formatUnitQuantity(rem, unit));
      if (parts.length > 0) return parts.join(' و ');
    }

    return formatUnitQuantity(totalUnits, unit);
  }

  if (unit === 'كيس') {
    const pkgSize =
      med.packageSize && med.packageSize > 0 ? med.packageSize : 10;
    const boxes = Math.floor(totalUnits / pkgSize);
    const rem = normalizeDisplayQuantity(totalUnits % pkgSize);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (rem > 0) parts.push(formatUnitQuantity(rem, 'كيس'));
    return parts.length > 0
      ? parts.join(' و ')
      : formatUnitQuantity(totalUnits, 'كيس');
  }

  if (unit === 'جرعة') {
    const pkgSize =
      med.packageSize && med.packageSize > 0 ? med.packageSize : 30;
    const boxes = Math.floor(totalUnits / pkgSize);
    const rem = normalizeDisplayQuantity(totalUnits % pkgSize);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (rem > 0) parts.push(formatUnitQuantity(rem, 'جرعة'));
    return parts.length > 0
      ? parts.join(' و ')
      : formatUnitQuantity(totalUnits, 'جرعة');
  }

  if (unit === 'مل') {
    const pkgSize =
      med.packageSize && med.packageSize > 0
        ? med.packageSize
        : DEFAULT_LIQUID_PACK_SIZE;
    const bottles = Math.floor(totalUnits / pkgSize);
    const rem = normalizeDisplayQuantity(totalUnits % pkgSize);
    const parts: string[] = [];
    if (bottles > 0) parts.push(pluralizeArabic(bottles, 'عبوة'));
    if (rem > 0) parts.push(formatUnitQuantity(rem, 'مل'));
    return parts.length > 0
      ? parts.join(' و ')
      : formatUnitQuantity(totalUnits, 'مل');
  }

  if (med.packageSize && med.packageSize > 0) {
    const boxes = Math.floor(totalUnits / med.packageSize);
    const rem = normalizeDisplayQuantity(totalUnits % med.packageSize);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (rem > 0) parts.push(formatUnitQuantity(rem, unit));
    if (parts.length > 0) return parts.join(' و ');
  }

  return formatUnitQuantity(totalUnits, unit);
}
