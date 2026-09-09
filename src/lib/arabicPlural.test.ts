import { describe, it, expect } from 'vitest';
import { pluralizeArabic } from './arabicPlural';

describe('pluralizeArabic', () => {
  describe('masculine unit: قرص', () => {
    it('1 → singular + واحد', () => {
      expect(pluralizeArabic(1, 'قرص')).toBe('قرص واحد');
    });
    it('2 → dual', () => {
      expect(pluralizeArabic(2, 'قرص')).toBe('قرصين');
    });
    it('3-10 → few form', () => {
      expect(pluralizeArabic(3, 'قرص')).toBe('3 أقراص');
      expect(pluralizeArabic(10, 'قرص')).toBe('10 أقراص');
    });
    it('11+ → many form', () => {
      expect(pluralizeArabic(11, 'قرص')).toBe('11 قرصاً');
      expect(pluralizeArabic(25, 'قرص')).toBe('25 قرصاً');
    });
    it('0 → few form with 0', () => {
      expect(pluralizeArabic(0, 'قرص')).toBe('0 أقراص');
    });
  });

  describe('feminine unit: كبسولة', () => {
    it('1 → singular + واحدة (feminine one)', () => {
      expect(pluralizeArabic(1, 'كبسولة')).toBe('كبسولة واحدة');
    });
    it('2 → dual', () => {
      expect(pluralizeArabic(2, 'كبسولة')).toBe('كبسولتين');
    });
    it('3-10 → few form', () => {
      expect(pluralizeArabic(5, 'كبسولة')).toBe('5 كبسولات');
    });
    it('11+ → many form', () => {
      expect(pluralizeArabic(15, 'كبسولة')).toBe('15 كبسولةً');
    });
  });

  describe('invariable unit: مل', () => {
    it('returns the same noun for all counts', () => {
      expect(pluralizeArabic(1, 'مل')).toBe('مل واحد');
      expect(pluralizeArabic(5, 'مل')).toBe('5 مل');
      expect(pluralizeArabic(15, 'مل')).toBe('15 مل');
    });
  });

  describe('packaging nouns', () => {
    it('علبة (box)', () => {
      expect(pluralizeArabic(1, 'علبة')).toBe('علبة واحدة');
      expect(pluralizeArabic(2, 'علبة')).toBe('علبتين');
      expect(pluralizeArabic(3, 'علبة')).toBe('3 علب');
      expect(pluralizeArabic(15, 'علبة')).toBe('15 علبة');
    });
    it('شريط (strip)', () => {
      expect(pluralizeArabic(1, 'شريط')).toBe('شريط واحد');
      expect(pluralizeArabic(2, 'شريط')).toBe('شريطين');
      expect(pluralizeArabic(5, 'شريط')).toBe('5 أشرطة');
      expect(pluralizeArabic(12, 'شريط')).toBe('12 شريطاً');
    });
  });

  describe('unknown unit fallback', () => {
    it('treats unknown units as masculine with a generic plural', () => {
      expect(pluralizeArabic(1, 'حقنة')).toBe('حقنة واحد');
      expect(pluralizeArabic(2, 'حقنة')).toBe('حقنةين');
      expect(pluralizeArabic(5, 'حقنة')).toBe('5 وحدات');
    });
  });

  it('handles negative counts gracefully', () => {
    expect(pluralizeArabic(-1, 'قرص')).toBe('-1 قرص');
  });
});
