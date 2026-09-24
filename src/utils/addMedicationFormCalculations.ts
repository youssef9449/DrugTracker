import { isSolidUnit } from './medicationPackaging';

export interface PackageConfigurationInput {
  unit: string;
  noStrips: boolean;
  packageSize: number;
  stripsPerBox: string;
  pillsPerStrip: string;
}

export function calculateStripBasedPackageSize(stripsPerBox: string, pillsPerStrip: string): number {
  const strips = Math.max(1, parseInt(stripsPerBox, 10) || 1);
  const pills = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
  return strips * pills;
}

export function calculateStockHelperTotal(
  stripsPerBox: string,
  pillsPerStrip: string,
  helperBoxes: string,
  helperStrips: string,
  helperLoose: string
): number {
  const boxSize = calculateStripBasedPackageSize(stripsPerBox, pillsPerStrip);
  const pillsPerStripValue = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
  const boxes = Math.max(0, parseInt(helperBoxes, 10) || 0);
  const strips = Math.max(0, parseInt(helperStrips, 10) || 0);
  const loose = Math.max(0, parseInt(helperLoose, 10) || 0);
  return boxes * boxSize + strips * pillsPerStripValue + loose;
}

export function calculatePackageConfiguration({
  unit,
  noStrips,
  packageSize,
  stripsPerBox,
  pillsPerStrip,
}: PackageConfigurationInput): {
  stripsPerBoxNum: number | undefined;
  pillsPerStripNum: number | undefined;
  calculatedPkgSize: number;
} {
  if (!isSolidUnit(unit)) {
    return {
      stripsPerBoxNum: undefined,
      pillsPerStripNum: undefined,
      calculatedPkgSize: Math.max(1, packageSize || (unit === 'مل' ? 100 : 30)),
    };
  }
  if (noStrips) {
    return {
      stripsPerBoxNum: undefined,
      pillsPerStripNum: undefined,
      calculatedPkgSize: Math.max(1, parseInt(stripsPerBox, 10) || packageSize || 30),
    };
  }
  const stripsPerBoxNum = Math.max(1, parseInt(stripsPerBox, 10) || 1);
  const pillsPerStripNum = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
  return {
    stripsPerBoxNum,
    pillsPerStripNum,
    calculatedPkgSize: stripsPerBoxNum * pillsPerStripNum,
  };
}
