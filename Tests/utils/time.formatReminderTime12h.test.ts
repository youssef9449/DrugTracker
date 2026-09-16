import { describe, it, expect } from 'vitest';
import { formatReminderTime12h } from '@/utils/time';

describe('formatReminderTime12h — display-only 12h Arabic AM/PM', () => {
  it.each([
    ['00:00', '12:00 ص'],
    ['00:05', '12:05 ص'],
    ['00:30', '12:30 ص'],
    ['01:00', '01:00 ص'],
    ['09:30', '09:30 ص'],
    ['11:59', '11:59 ص'],
    ['12:00', '12:00 م'],
    ['12:01', '12:01 م'],
    ['13:00', '01:00 م'],
    ['21:30', '09:30 م'],
    ['22:00', '10:00 م'],
    ['23:59', '11:59 م'],
  ] as const)('%s → %s', (input, expected) => {
    expect(formatReminderTime12h(input)).toBe(expected);
  });

  it('returns invalid input unchanged', () => {
    expect(formatReminderTime12h('')).toBe('');
    expect(formatReminderTime12h('25:00')).toBe('25:00');
    expect(formatReminderTime12h('ab:cd')).toBe('ab:cd');
    expect(formatReminderTime12h('9')).toBe('9');
  });
});
