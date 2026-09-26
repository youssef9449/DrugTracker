import { DEFAULT_MEDICATION_UNIT } from '../constants/medicationDefaults';
import type { Medication } from '../types';
import { pluralizeArabic } from '../lib/arabicPlural';
import {
  DEFAULT_BAG_PACK_SIZE,
  DEFAULT_LIQUID_PACK_SIZE,
  DEFAULT_SOLID_PACK_SIZE,
  DAYS_PER_MONTH,
} from './time';
import { dailyScheduleAmount } from './dateCalculations';

export function isSolidUnit(unit: string): boolean {
  return unit === 'قرص' || unit === 'كبسولة';
}

export function normalizeDisplayQuantity(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const nearest = Math.round(value);
  const scale = Math.max(Math.abs(value), Math.abs(nearest), 1);
  const intEps = Number.EPSILON * scale * 2048;
  if (Math.abs(value - nearest) <= intEps) return nearest;

  const abs = Math.abs(value);
  if (abs === 0) return 0;
  const exp2 = Math.floor(Math.log2(abs));
  const ulp = Math.pow(2, exp2 - 52);

  for (let places = 1; places <= 17; places += 1) {
    const factor = 10 ** places;
    const candidate = Math.round(value * factor) / factor;
    if (Math.abs(value - candidate) <= ulp) return candidate;
  }

  return value;
}

export function formatUnitQuantity(value: number, unit: string): string {
  const n = normalizeDisplayQuantity(value);
  return Number.isInteger(n) ? pluralizeArabic(n, unit) : `${n} ${unit}`;
}

export function describeStockInStrips(
  pills: number,
  pillsPerStrip?: number,
  stripsPerBox?: number,
  unit: string = DEFAULT_MEDICATION_UNIT
): string | null {
  if (!isSolidUnit(unit) || !pillsPerStrip || pillsPerStrip <= 0 || pills <= 0) {
    return null;
  }

  const totalStrips = Math.floor(pills / pillsPerStrip);
  const remainingPills = normalizeDisplayQuantity(pills - totalStrips * pillsPerStrip);
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
  if (totalStrips > 0 && remainingPills > 0) return `${stripWord} و ${pillWord}`;
  if (totalStrips > 0) return stripWord;
  if (remainingPills > 0) return pillWord;
  return null;
}

export interface EffectivePackageSizeInput {
  unit: string;
  packageSize?: number;
  stripsPerBox?: number;
  pillsPerStrip?: number;
}

/** Resolve the canonical effective package size for packaging calculations. */
export function getEffectivePackageSize({
  unit,
  packageSize,
  stripsPerBox,
  pillsPerStrip,
}: EffectivePackageSizeInput): number {
  const solid = isSolidUnit(unit);
  if (solid && stripsPerBox && pillsPerStrip && stripsPerBox > 0 && pillsPerStrip > 0) {
    return stripsPerBox * pillsPerStrip;
  }
  if (packageSize && packageSize > 0) return packageSize;
  if (unit === 'مل') return DEFAULT_LIQUID_PACK_SIZE;
  if (unit === 'كيس') return DEFAULT_BAG_PACK_SIZE;
  return DEFAULT_SOLID_PACK_SIZE;
}

export function describeOrderInBoxes(
  targetPills: number,
  stripsPerBox?: number,
  pillsPerStrip?: number,
  packageSize?: number,
  unit: string = DEFAULT_MEDICATION_UNIT
): string {
  const solid = isSolidUnit(unit);
  const boxWordLabel = unit === 'مل' ? 'عبوة' : 'علبة';
  const boxSize = getEffectivePackageSize({ unit, packageSize, stripsPerBox, pillsPerStrip });
  const stripSize = solid && pillsPerStrip && pillsPerStrip > 0 ? pillsPerStrip : null;
  const boxes = Math.floor(targetPills / boxSize);
  const remainder = targetPills % boxSize;

  if (boxes > 0 && remainder === 0) {
    return pluralizeArabic(boxes, boxWordLabel);
  }

  if (boxes > 0 && stripSize && remainder > 0) {
    const strips = Math.floor(remainder / stripSize);
    const loose = remainder % stripSize;
    const parts = [pluralizeArabic(boxes, boxWordLabel)];
    if (strips > 0) parts.push(pluralizeArabic(strips, 'شريط'));
    if (loose > 0) parts.push(pluralizeArabic(Math.ceil(loose / stripSize), 'شريط'));
    return parts.join(' و ');
  }

  if (boxes > 0 && !stripSize && remainder > 0) {
    if (solid) return pluralizeArabic(boxes + 1, boxWordLabel);
    return `${pluralizeArabic(boxes, boxWordLabel)} و ${pluralizeArabic(remainder, unit)}`;
  }

  if (boxes === 0 && stripSize && remainder > 0) {
    return pluralizeArabic(Math.ceil(remainder / stripSize), 'شريط');
  }

  if (boxes === 0 && !stripSize && solid && targetPills > 0) {
    return pluralizeArabic(1, boxWordLabel);
  }

  return pluralizeArabic(targetPills, unit);
}

export interface MedSizes {
  boxSize: number;
  stripSize: number;
  hasStrips: boolean;
  isSolid: boolean;
}

export function getMedSizes(med: Medication): MedSizes {
  const solid = isSolidUnit(med.unit);
  const stripsPerBox = med.stripsPerBox;
  const pillsPerStrip = med.pillsPerStrip;
  const hasStrips =
    solid && Boolean(stripsPerBox && pillsPerStrip && stripsPerBox > 0 && pillsPerStrip > 0);
  const boxSize = getEffectivePackageSize({ unit: med.unit, packageSize: med.packageSize, stripsPerBox, pillsPerStrip });
  const stripSize = hasStrips && pillsPerStrip && pillsPerStrip > 0 ? pillsPerStrip : 0;

  return { boxSize, stripSize, hasStrips, isSolid: solid };
}

export function formatScheduledDoseBreakdown(med: Medication, isDaily: boolean): string {
  const slots = Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0
    ? med.doseSchedule.length
    : 0;
  if (slots <= 0) return '0 جرعة';

  const dailyAmt = dailyScheduleAmount(med);
  const effective = dailyAmt > 0 ? dailyAmt : slots;
  const total = isDaily ? effective : effective * DAYS_PER_MONTH;
  const unit = med.unit || DEFAULT_MEDICATION_UNIT;

  if (isSolidUnit(unit)) {
    if (med.pillsPerStrip && med.pillsPerStrip > 0) {
      const breakdown = describeStockInStrips(
        total,
        med.pillsPerStrip,
        med.stripsPerBox,
        unit
      );
      if (breakdown) return breakdown;
    }

    if (med.packageSize && med.packageSize > 0) {
      const size = getEffectivePackageSize({ unit, packageSize: med.packageSize });
      const boxes = Math.floor(total / size);
      const remainder = normalizeDisplayQuantity(total % size);
      const parts: string[] = [];
      if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
      if (remainder > 0) parts.push(formatUnitQuantity(remainder, unit));
      if (parts.length > 0) return parts.join(' و ');
    }

    return formatUnitQuantity(total, unit);
  }

  if (unit === 'كيس') {
    const size = getEffectivePackageSize({ unit, packageSize: med.packageSize });
    const boxes = Math.floor(total / size);
    const remainder = normalizeDisplayQuantity(total % size);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (remainder > 0) parts.push(formatUnitQuantity(remainder, 'كيس'));
    return parts.length ? parts.join(' و ') : formatUnitQuantity(total, 'كيس');
  }

  if (unit === 'جرعة') {
    const size = getEffectivePackageSize({ unit, packageSize: med.packageSize });
    const boxes = Math.floor(total / size);
    const remainder = normalizeDisplayQuantity(total % size);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (remainder > 0) parts.push(formatUnitQuantity(remainder, 'جرعة'));
    return parts.length ? parts.join(' و ') : formatUnitQuantity(total, 'جرعة');
  }

  if (unit === 'مل') {
    const size = getEffectivePackageSize({ unit, packageSize: med.packageSize });
    const bottles = Math.floor(total / size);
    const remainder = normalizeDisplayQuantity(total % size);
    const parts: string[] = [];
    if (bottles > 0) parts.push(pluralizeArabic(bottles, 'عبوة'));
    if (remainder > 0) parts.push(formatUnitQuantity(remainder, 'مل'));
    return parts.length ? parts.join(' و ') : formatUnitQuantity(total, 'مل');
  }

  if (med.packageSize && med.packageSize > 0) {
    const boxes = Math.floor(total / med.packageSize);
    const remainder = normalizeDisplayQuantity(total % med.packageSize);
    const parts: string[] = [];
    if (boxes > 0) parts.push(pluralizeArabic(boxes, 'علبة'));
    if (remainder > 0) parts.push(formatUnitQuantity(remainder, unit));
    if (parts.length > 0) return parts.join(' و ');
  }

  return formatUnitQuantity(total, unit);
}