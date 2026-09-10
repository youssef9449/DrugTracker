import { describe, it, expect } from 'vitest';
import {
  normalizeArabicDigits,
  cleanPhoneNumber,
  generatePharmacyOrderMessage,
  buildWhatsAppUrl,
  buildWhatsAppApiUrl,
  buildWhatsAppAppUrl,
  calculateMedicationOrderQuantity,
} from './whatsapp';
import type { Medication } from '../types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    stripsPerBox: 3,
    pillsPerStrip: 10,
    packageSize: 30,
    ...overrides,
  };
}

describe('normalizeArabicDigits', () => {
  it('converts Arabic-Indic digits to 0-9', () => {
    expect(normalizeArabicDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('converts Persian digits to 0-9', () => {
    expect(normalizeArabicDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('leaves latin digits and other chars untouched', () => {
    expect(normalizeArabicDigits('Phone: 010-1234')).toBe('Phone: 010-1234');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeArabicDigits('')).toBe('');
  });
});

describe('cleanPhoneNumber', () => {
  it('prefixes Egyptian mobile numbers with 20', () => {
    expect(cleanPhoneNumber('01012345678')).toBe('201012345678');
    expect(cleanPhoneNumber('01123456789')).toBe('201123456789');
    expect(cleanPhoneNumber('01234567890')).toBe('201234567890');
    expect(cleanPhoneNumber('01567890123')).toBe('201567890123');
  });

  it('prefixes Egyptian landlines with 20', () => {
    expect(cleanPhoneNumber('0212345678')).toBe('20212345678');
  });

  it('strips spaces, dashes, parens, and +', () => {
    expect(cleanPhoneNumber('+20 10 1234 5678')).toBe('201012345678');
    // Valid 11-digit Egyptian mobile (010 1234 5678)
    expect(cleanPhoneNumber('(010) 1234-5678')).toBe('201012345678');
  });

  it('handles Egyptian numbers entered without leading 0 (10 digits)', () => {
    expect(cleanPhoneNumber('1012345678')).toBe('201012345678');
    expect(cleanPhoneNumber('1123456789')).toBe('201123456789');
  });

  it('handles Egyptian numbers with redundant 0 after 20 (+20 010...)', () => {
    expect(cleanPhoneNumber('+2001012345678')).toBe('201012345678');
    expect(cleanPhoneNumber('002001012345678')).toBe('201012345678');
  });

  it('normalizes Arabic-Indic digits before parsing', () => {
    expect(cleanPhoneNumber('٠١٠١٢٣٤٥٦٧٨')).toBe('201012345678');
  });

  it('strips a leading 00 international prefix and keeps the rest', () => {
    expect(cleanPhoneNumber('00971501234567')).toBe('971501234567');
    expect(cleanPhoneNumber('00966501234567')).toBe('966501234567');
  });

  it('preserves already-international numbers without a 00 prefix', () => {
    // A Saudi number with explicit country code, no leading 00.
    expect(cleanPhoneNumber('966501234567')).toBe('966501234567');
  });

  it('returns empty for empty input', () => {
    expect(cleanPhoneNumber('')).toBe('');
  });
});

describe('generatePharmacyOrderMessage', () => {
  it('returns empty string for no items', () => {
    expect(generatePharmacyOrderMessage([])).toBe('');
  });

  it('lists each item with a numbered prefix', () => {
    const msg = generatePharmacyOrderMessage([
      { name: 'كونكور 5 مجم', quantity: 30, unit: 'قرص', packageSize: 30 },
    ]);
    expect(msg).toContain('1. كونكور 5 مجم');
    expect(msg).toContain('30 قرص');
  });

  it('omits the customer code line when not provided or blank', () => {
    const msgEmpty = generatePharmacyOrderMessage([
      { name: 'كونكور 5 مجم', quantity: 30, unit: 'قرص', packageSize: 30 },
    ], '');
    expect(msgEmpty).not.toContain('رقم العميل');

    const msgWhitespace = generatePharmacyOrderMessage([
      { name: 'كونكور 5 مجم', quantity: 30, unit: 'قرص', packageSize: 30 },
    ], '   ');
    expect(msgWhitespace).not.toContain('رقم العميل');
  });

  it('includes the customer code line when provided', () => {
    const msg = generatePharmacyOrderMessage([
      { name: 'كونكور 5 مجم', quantity: 30, unit: 'قرص', packageSize: 30 },
    ], '14739');
    expect(msg).toContain('رقم العميل 14739');
  });

  it('includes address and contactPhone when provided', () => {
    const msg = generatePharmacyOrderMessage(
      [{ name: 'M', quantity: 30, unit: 'قرص', packageSize: 30 }],
      '',
      'شارع 15',
      '01012345678'
    );
    expect(msg).toContain('العنوان: شارع 15');
    expect(msg).toContain('رقم التواصل: 01012345678');
  });

  it('omits address/contactPhone lines when blank', () => {
    const msg = generatePharmacyOrderMessage(
      [{ name: 'M', quantity: 30, unit: 'قرص', packageSize: 30 }],
      '',
      '   ',
      ''
    );
    expect(msg).not.toContain('العنوان:');
    expect(msg).not.toContain('رقم التواصل:');
  });
});

describe('buildWhatsAppUrl', () => {
  it('builds a wa.me URL with the cleaned phone + encoded text', () => {
    const url = buildWhatsAppUrl('01012345678', 'مرحبا');
    expect(url).toBe('https://wa.me/201012345678?text=' + encodeURIComponent('مرحبا'));
  });

  it('builds a wa.me URL without the phone when empty', () => {
    const url = buildWhatsAppUrl('', 'مرحبا');
    expect(url).toBe('https://wa.me/?text=' + encodeURIComponent('مرحبا'));
  });

  it('builds an api.whatsapp.com URL with phone and encoded text', () => {
    const url = buildWhatsAppApiUrl('01012345678', 'مرحبا');
    expect(url).toBe('https://api.whatsapp.com/send?phone=201012345678&text=' + encodeURIComponent('مرحبا'));
  });

  it('builds a whatsapp:// native app URL', () => {
    const url = buildWhatsAppAppUrl('01012345678', 'مرحبا');
    expect(url).toBe('whatsapp://send?phone=201012345678&text=' + encodeURIComponent('مرحبا'));
  });
});

describe('calculateMedicationOrderQuantity', () => {
  it('uses the custom quantity when provided', () => {
    const med = makeMed({ id: 'med-1' });
    const r = calculateMedicationOrderQuantity(med, 30, { 'med-1': 20 });
    expect(r.quantity).toBe(20);
    expect(r.isCustom).toBe(true);
  });

  it('doubles the custom quantity for 60-day duration', () => {
    const med = makeMed({ id: 'med-1' });
    const r = calculateMedicationOrderQuantity(med, 60, { 'med-1': 20 });
    expect(r.quantity).toBe(40);
  });

  it('orders one full package when monthly consumption fits in one package', () => {
    // dailyDose 1 → 30/month; packageSize 30 → exactly one package
    const med = makeMed({ dailyDose: 1, packageSize: 30, stripsPerBox: 3, pillsPerStrip: 10 });
    const r = calculateMedicationOrderQuantity(med, 30);
    expect(r.isCustom).toBe(false);
    expect(r.quantity).toBe(30);
  });

  it('orders the exact pill count when monthly consumption exceeds one package', () => {
    // dailyDose 2 → 60/month; packageSize 30 → more than one package → exact 60
    const med = makeMed({ dailyDose: 2, packageSize: 30, stripsPerBox: 3, pillsPerStrip: 10 });
    const r = calculateMedicationOrderQuantity(med, 30);
    expect(r.quantity).toBe(60);
  });

  it('orders one package when dailyDose is 0', () => {
    const med = makeMed({ dailyDose: 0, packageSize: 30 });
    const r = calculateMedicationOrderQuantity(med, 30);
    expect(r.quantity).toBe(30);
  });

  it('falls back to a 30-pill package when no packaging info is set', () => {
    const med = makeMed({ dailyDose: 1, stripsPerBox: undefined, pillsPerStrip: undefined, packageSize: undefined });
    const r = calculateMedicationOrderQuantity(med, 30);
    expect(r.quantity).toBe(30);
  });
});
