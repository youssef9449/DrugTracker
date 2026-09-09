import { describe, it, expect } from 'vitest';
import { cleanPhoneNumber } from './whatsapp';

/**
 * #28 — cleanPhoneNumber must strip ALL non-digits, not just
 * spaces/dashes/parens/plus. Letters, dots, slashes, colons etc. must
 * also be removed so they don't produce invalid wa.me URLs.
 */
describe('cleanPhoneNumber — strips all non-digits (#28)', () => {
  it('strips letters from a phone-like string', () => {
    expect(cleanPhoneNumber('Phone: 01012345678')).toBe('201012345678');
  });

  it('strips dots from a dotted number', () => {
    expect(cleanPhoneNumber('010.1234.5678')).toBe('201012345678');
  });

  it('strips slashes', () => {
    expect(cleanPhoneNumber('010/1234/5678')).toBe('201012345678');
  });

  it('strips colons', () => {
    expect(cleanPhoneNumber('010:1234:5678')).toBe('201012345678');
  });

  it('strips a mix of non-digit characters', () => {
    expect(cleanPhoneNumber('Tel: 010-1234.5678 (ext)')).toBe('201012345678');
  });

  it('still handles valid Egyptian mobile correctly', () => {
    expect(cleanPhoneNumber('01012345678')).toBe('201012345678');
    expect(cleanPhoneNumber('+20 10 1234 5678')).toBe('201012345678');
  });

  it('still handles international with 00 prefix', () => {
    expect(cleanPhoneNumber('00971501234567')).toBe('971501234567');
  });

  it('still handles already-international (no 00)', () => {
    expect(cleanPhoneNumber('966501234567')).toBe('966501234567');
  });
});
