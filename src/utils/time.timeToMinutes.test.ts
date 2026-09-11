import { describe, it, expect } from 'vitest';
import { timeToMinutes } from './time';

/**
 * #25 — timeToMinutes must reject out-of-range hours/minutes, not just
 * NaN. Before the fix, "25:99" returned 1599 (an unreachable minute count
 * that made the reminder silently never fire because `nowMins` maxes at
 * 1439). Now it returns -1 so the polling effect skips the reminder
 * cleanly.
 */
describe('timeToMinutes (#25)', () => {
  it('converts valid 24-hour times to minutes since midnight', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('00:01')).toBe(1);
    expect(timeToMinutes('09:00')).toBe(540);
    expect(timeToMinutes('14:30')).toBe(870);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('returns -1 for NaN hour or minute', () => {
    expect(timeToMinutes('')).toBe(-1);
    expect(timeToMinutes('aa:bb')).toBe(-1);
    expect(timeToMinutes('9')).toBe(-1);
    expect(timeToMinutes(':30')).toBe(-1);
    expect(timeToMinutes('09:')).toBe(-1);
  });

  it('returns -1 for out-of-range hours (> 23)', () => {
    expect(timeToMinutes('24:00')).toBe(-1);
    expect(timeToMinutes('25:00')).toBe(-1);
    expect(timeToMinutes('99:00')).toBe(-1);
  });

  it('returns -1 for out-of-range minutes (> 59)', () => {
    expect(timeToMinutes('09:60')).toBe(-1);
    expect(timeToMinutes('09:99')).toBe(-1);
    expect(timeToMinutes('23:99')).toBe(-1);
  });

  it('returns -1 for negative hour or minute', () => {
    expect(timeToMinutes('-1:00')).toBe(-1);
    expect(timeToMinutes('00:-1')).toBe(-1);
  });

  it('accepts single-digit hour (no leading zero)', () => {
    // "9:00" — parseInt('9') = 9, valid. The polling effect uses
    // getNowHHMM which always zero-pads, but a stored reminderTime might
    // be single-digit.
    expect(timeToMinutes('9:00')).toBe(540);
    expect(timeToMinutes('9:5')).toBe(545);
  });
});
