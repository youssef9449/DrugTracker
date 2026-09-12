import { describe, it, expect, beforeEach } from 'vitest';
import {
  SNOOZE_KEY,
  snoozeStorageKey,
  clearSnoozedDose,
  isSnoozeActive,
  setSnoozeUntil,
} from './doseReminderStorage';
import { LEGACY_DOSE_ID } from './notifications';

describe('doseReminderStorage Phase 3B dose-scoped snooze', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('legacy key is med-only', () => {
    expect(snoozeStorageKey('m1')).toBe('m1');
    expect(snoozeStorageKey('m1', LEGACY_DOSE_ID)).toBe('m1');
    expect(snoozeStorageKey('m1', null)).toBe('m1');
  });

  it('multi-dose key is med::dose', () => {
    expect(snoozeStorageKey('m1', 'd2')).toBe('m1::d2');
  });

  it('snoozing d2 does not suppress d1', () => {
    setSnoozeUntil('m1', Date.now() + 60_000, 'd2');
    expect(isSnoozeActive('m1', 'd2')).toBe(true);
    expect(isSnoozeActive('m1', 'd1')).toBe(false);
    expect(isSnoozeActive('m1')).toBe(false);
  });

  it('clearSnoozedDose only clears the targeted key', () => {
    setSnoozeUntil('m1', Date.now() + 60_000, 'd1');
    setSnoozeUntil('m1', Date.now() + 60_000, 'd2');
    clearSnoozedDose('m1', 'd1');
    expect(isSnoozeActive('m1', 'd1')).toBe(false);
    expect(isSnoozeActive('m1', 'd2')).toBe(true);
  });

  it('expired snooze is not active', () => {
    setSnoozeUntil('m1', Date.now() - 1, 'd1');
    expect(isSnoozeActive('m1', 'd1')).toBe(false);
  });

  it('persists under SNOOZE_KEY', () => {
    setSnoozeUntil('m1', 12345, 'd3');
    const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}');
    expect(raw['m1::d3']).toBe(12345);
  });
});
