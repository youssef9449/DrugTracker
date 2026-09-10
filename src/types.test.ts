import { describe, it, expect } from 'vitest';
import {
  calculateMedicationStatus,
  getCriticalThresholdDays,
  formatTimeArabic,
  describeStockInStrips,
  describeOrderInBoxes,
  isSolidUnit,
  DEFAULT_PHARMACY_SETTINGS,
  type Medication,
} from './types';
import { getTodayDateString } from './utils/dateCalculations';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  // lastSyncDate defaults to today so effectiveCurrentPills() ===
  // currentPills (no days have passed). Tests that exercise the
  // dynamic-balance projection override lastSyncDate explicitly.
  return {
    id: 'med-test',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    ...overrides,
  };
}

describe('getCriticalThresholdDays', () => {
  it('returns half the warningThresholdDays, floored, minimum 1', () => {
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 5 }))).toBe(2);
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 7 }))).toBe(3);
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 10 }))).toBe(5);
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 1 }))).toBe(1);
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 2 }))).toBe(1);
  });

  it('falls back to 5 when warningThresholdDays is 0/missing', () => {
    expect(getCriticalThresholdDays(makeMed({ warningThresholdDays: 0 }))).toBe(2);
  });
});

describe('calculateMedicationStatus', () => {
  it('returns out_of_stock when currentPills <= 0', () => {
    const s = calculateMedicationStatus(makeMed({ currentPills: 0, dailyDose: 1 }));
    expect(s.status).toBe('out_of_stock');
    expect(s.daysLeft).toBe(0);
  });

  it('returns sufficient/undefined when dailyDose <= 0', () => {
    const s = calculateMedicationStatus(makeMed({ currentPills: 10, dailyDose: 0 }));
    expect(s.status).toBe('sufficient');
    expect(s.daysLeft).toBe(999);
  });

  it('returns critical when daysLeft <= derived critical threshold', () => {
    // warningThresholdDays 5 → critical threshold 2
    expect(
      calculateMedicationStatus(makeMed({ currentPills: 2, dailyDose: 1 })).status
    ).toBe('critical');
    expect(
      calculateMedicationStatus(makeMed({ currentPills: 3, dailyDose: 1 })).status
    ).toBe('warning');
  });

  it('critical threshold scales with warningThresholdDays', () => {
    // warningThresholdDays 10 → critical threshold 5
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 5, dailyDose: 1, warningThresholdDays: 10 })
      ).status
    ).toBe('critical');
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 10 })
      ).status
    ).toBe('warning');
  });

  it('returns warning when daysLeft <= warningThresholdDays but > critical', () => {
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 4, dailyDose: 1, warningThresholdDays: 5 })
      ).status
    ).toBe('warning');
  });

  it('returns sufficient when daysLeft > warningThresholdDays', () => {
    expect(
      calculateMedicationStatus(
        makeMed({ currentPills: 30, dailyDose: 1, warningThresholdDays: 5 })
      ).status
    ).toBe('sufficient');
  });
});

describe('formatTimeArabic', () => {
  it('formats valid 24-hour times to Arabic 12-hour', () => {
    expect(formatTimeArabic('09:00')).toBe('9:00 ص');
    expect(formatTimeArabic('21:30')).toBe('9:30 م');
    expect(formatTimeArabic('00:00')).toBe('12:00 ص'); // midnight
    expect(formatTimeArabic('12:00')).toBe('12:00 م'); // noon
    expect(formatTimeArabic('23:59')).toBe('11:59 م');
  });

  it('returns the raw string for invalid shapes (no crash)', () => {
    expect(formatTimeArabic('')).toBe('');
    expect(formatTimeArabic('9')).toBe('9');
    expect(formatTimeArabic('25:00')).toBe('25:00'); // hour out of range
    expect(formatTimeArabic('09:60')).toBe('09:60'); // minute out of range
    expect(formatTimeArabic('aa:bb')).toBe('aa:bb');
  });
});

describe('describeStockInStrips', () => {
  it('returns null when pillsPerStrip is missing or pills <= 0', () => {
    expect(describeStockInStrips(10)).toBeNull();
    expect(describeStockInStrips(0, 10, 3)).toBeNull();
    expect(describeStockInStrips(-5, 10, 3)).toBeNull();
  });

  it('breaks down into boxes + strips + pills using Arabic plurals', () => {
    // 35 pills, 10 per strip, 3 strips per box → 1 box + 0 strips + 5 pills
    expect(describeStockInStrips(35, 10, 3, 'قرص')).toBe('علبة واحدة و 5 أقراص');
    // 25 pills, 10 per strip, 3 strips per box → 0 boxes + 2 strips + 5 pills
    expect(describeStockInStrips(25, 10, 3, 'قرص')).toBe('شريطين و 5 أقراص');
    // 1 pill → "قرص واحد"
    expect(describeStockInStrips(1, 10, 3, 'قرص')).toBe('قرص واحد');
    // 2 pills → "قرصين"
    expect(describeStockInStrips(2, 10, 3, 'قرص')).toBe('قرصين');
  });

  it('uses the unit arg for the loose-pill word', () => {
    expect(describeStockInStrips(5, 10, 3, 'كبسولة')).toBe('5 كبسولات');
  });

  it('returns null for non-solid medication (e.g. مل syrup)', () => {
    expect(describeStockInStrips(100, 10, 3, 'مل')).toBeNull();
    expect(describeStockInStrips(50, undefined, undefined, 'مل')).toBeNull();
  });
});

describe('describeOrderInBoxes', () => {
  it('returns exact box count when target divides evenly', () => {
    // 30 pills, box of 30 → "علبة واحدة (30 قرصاً)" — Arabic 11+ rule
    expect(describeOrderInBoxes(30, 3, 10, 30, 'قرص')).toBe('علبة واحدة (30 قرصاً)');
    expect(describeOrderInBoxes(60, 3, 10, 30, 'قرص')).toBe('علبتين (60 قرصاً)');
  });

  it('handles liquid medication (مل) using عبوة and ignores strips', () => {
    // 100 ml bottle, ordering 100 ml → "عبوة واحدة (100 مل)"
    expect(describeOrderInBoxes(100, undefined, undefined, 100, 'مل')).toBe('عبوة واحدة (100 مل)');
    // 100 ml bottle, ordering 200 ml → "عبوتين (200 مل)"
    expect(describeOrderInBoxes(200, undefined, undefined, 100, 'مل')).toBe('عبوتين (200 مل)');
    // 100 ml bottle, ordering 120 ml → "عبوة واحدة و 20 مل (120 مل)"
    expect(describeOrderInBoxes(120, undefined, undefined, 100, 'مل')).toBe('عبوة واحدة و 20 مل (120 مل)');
  });

  it('breaks into boxes + strips when remainder is whole strips', () => {
    // 40 pills, box of 30 (3 strips × 10), strip of 10 → 1 box + 1 strip
    expect(describeOrderInBoxes(40, 3, 10, 30, 'قرص')).toBe(
      'علبة واحدة و شريط واحد (40 قرصاً)'
    );
  });

  it('falls back to ~box count when remainder has loose pills', () => {
    // 45 pills, box of 30 → 1 box + 1 strip + 5 loose pills
    expect(describeOrderInBoxes(45, 3, 10, 30, 'قرص')).toBe(
      'علبة واحدة و شريط واحد و 5 أقراص (45 قرصاً)'
    );
  });

  it('returns the bare plural when target < one box', () => {
    expect(describeOrderInBoxes(15, 3, 10, 30, 'قرص')).toBe('شريط واحد و 5 أقراص (15 قرصاً)');
  });
});

describe('DEFAULT_PHARMACY_SETTINGS', () => {
  it('has safe defaults', () => {
    expect(DEFAULT_PHARMACY_SETTINGS.pharmacyPhone).toBe('');
    expect(DEFAULT_PHARMACY_SETTINGS.pharmacyName).toBe('');
    expect(DEFAULT_PHARMACY_SETTINGS.customerCode).toBe('');
    expect(DEFAULT_PHARMACY_SETTINGS.defaultDurationDays).toBe(30);
    expect(DEFAULT_PHARMACY_SETTINGS.customQuantities).toEqual({});
  });
});

describe('isSolidUnit (#72)', () => {
  it('returns true for قرص (pill)', () => {
    expect(isSolidUnit('قرص')).toBe(true);
  });

  it('returns true for كبسولة (capsule)', () => {
    expect(isSolidUnit('كبسولة')).toBe(true);
  });

  it('returns false for مل (liquid milliliters)', () => {
    expect(isSolidUnit('مل')).toBe(false);
  });

  it('returns false for arbitrary custom units', () => {
    expect(isSolidUnit('جرعة')).toBe(false);
    expect(isSolidUnit('كيس')).toBe(false);
    expect(isSolidUnit('ampule')).toBe(false);
    expect(isSolidUnit('')).toBe(false);
  });

  it('is case-sensitive (Arabic strings have no case, but verify no surprises)', () => {
    // Whitespace / near-miss strings should not match.
    expect(isSolidUnit(' قرص')).toBe(false);
    expect(isSolidUnit('قرص ')).toBe(false);
    expect(isSolidUnit('القرص')).toBe(false);
  });
});
