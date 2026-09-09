/**
 * Arabic pluralization helper.
 *
 * Arabic has a complex pluralization system:
 *   1        → singular (اسم مفرد)        e.g. "قرص واحد"
 *   2        → dual (مثنى)                 e.g. "قرصان"
 *   3–10     → plural genitive (جمع مجرور) e.g. "3 أقراص", "7 كبسولات"
 *   11+      → singular accusative (مفرد منصوب) e.g. "11 قرصاً"
 *
 * The noun form depends on the unit's "sound" vs "broken" plural class.
 * This helper covers the five built-in units declared in
 * AddMedicationModal's unit <select> and a sensible generic fallback for
 * any custom unit the user types.
 *
 * Returned phrases:
 *   pluralizeArabic(1, 'قرص')     → "قرص واحد"
 *   pluralizeArabic(2, 'قرص')    → "قرصان"
 *   pluralizeArabic(5, 'قرص')    → "5 أقراص"
 *   pluralizeArabic(15, 'قرص')   → "15 قرصاً"
 *   pluralizeArabic(1, 'كبسولة') → "كبسولة واحدة"
 *   pluralizeArabic(2, 'كبسولة') → "كبسولتان"
 */

/** Known unit forms. `singular`/`dual`/`few`(3-10)/`many`(11+) are the
 * noun forms; the count word (if any) is rendered by the caller. */
interface ArabicUnitForms {
  /** Singular noun, no article (used for 1 and 11+). */
  singular: string;
  /** Dual form (used for 2). */
  dual: string;
  /** Plural form for 3–10. */
  few: string;
  /** Accusative singular form for 11+ (with fatha / tanween). */
  many: string;
  /** Whether the noun is grammatically feminine (affects "واحدة" vs "واحد"). */
  feminine: boolean;
}

const KNOWN_UNITS: Record<string, ArabicUnitForms> = {
  // قرص (pill) — masculine
  'قرص': {
    singular: 'قرص',
    dual: 'قرصان',
    few: 'أقراص',
    many: 'قرصاً',
    feminine: false,
  },
  // كبسولة (capsule) — feminine
  'كبسولة': {
    singular: 'كبسولة',
    dual: 'كبسولتان',
    few: 'كبسولات',
    many: 'كبسولةً',
    feminine: true,
  },
  // مل (milliliter) — invariable (doesn't pluralize like a noun)
  'مل': {
    singular: 'مل',
    dual: 'مل',
    few: 'مل',
    many: 'مل',
    feminine: false,
  },
  // جرعة (dose) — feminine
  'جرعة': {
    singular: 'جرعة',
    dual: 'جرعتان',
    few: 'جرعات',
    many: 'جرعةً',
    feminine: true,
  },
  // كيس (sachet) — masculine
  'كيس': {
    singular: 'كيس',
    dual: 'كيسان',
    few: 'أكياس',
    many: 'كيلاً',
    feminine: false,
  },
  // علبة (box) — feminine. Used by describeStockInStrips/describeOrderInBoxes.
  'علبة': {
    singular: 'علبة',
    dual: 'علبتان',
    few: 'علب',
    many: 'علبة',
    feminine: true,
  },
  // شريط (strip) — masculine. Used by describeStockInStrips/describeOrderInBoxes.
  'شريط': {
    singular: 'شريط',
    dual: 'شريطان',
    few: 'أشرطة',
    many: 'شريطاً',
    feminine: false,
  },
};

/**
 * Get the noun forms for a unit. Falls back to a generic pattern for
 * custom units: treat unknown units as masculine and use a generic
 * "وحدات" plural (which is reasonably natural for most nouns).
 */
function getUnitForms(unit: string): ArabicUnitForms {
  const known = KNOWN_UNITS[unit];
  if (known) return known;
  return {
    singular: unit,
    dual: `${unit}ان`,
    few: 'وحدات',
    many: `${unit}اً`,
    feminine: false,
  };
}

/**
 * Pluralize a count + unit into a natural Arabic phrase.
 *
 * @param count  the number of items (>= 0)
 * @param unit   the unit noun (e.g. 'قرص', 'كبسولة')
 * @returns      e.g. "قرص واحد", "قرصان", "5 أقراص", "15 قرصاً"
 */
export function pluralizeArabic(count: number, unit: string): string {
  if (count < 0) return `${count} ${unit}`;
  const forms = getUnitForms(unit);
  const oneWord = forms.feminine ? 'واحدة' : 'واحد';

  if (count === 0) return `0 ${forms.few}`;
  if (count === 1) return `${forms.singular} ${oneWord}`;
  if (count === 2) return forms.dual;
  if (count <= 10) return `${count} ${forms.few}`;
  // 11+
  return `${count} ${forms.many}`;
}
