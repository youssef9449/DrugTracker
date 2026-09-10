import { Medication, isSolidUnit } from '../types';
import { DEFAULT_LIQUID_PACK_SIZE, DEFAULT_SOLID_PACK_SIZE } from './time';

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
