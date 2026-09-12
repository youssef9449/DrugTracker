import { describe, it, expect } from 'vitest';
import {
  MS_PER_MINUTE,
  MS_PER_DAY,
  NEVER_DEPLETES_DAYS,
  REMINDER_POLL_INTERVAL_MS,
  DEFAULT_SNOOZE_MINUTES,
  NOTIFICATION_IMMEDIATE_OFFSET_MS,
  CRITICAL_ALARM_FIRE_HOUR,
  TOAST_DURATION_MS,
  PHARMACY_PERSIST_DEBOUNCE_MS,
  SW_READY_TIMEOUT_MS,
  VISUAL_RANGE_MULTIPLIER,
  MIN_VISUAL_RANGE_DAYS,
  MAX_LOG_ROWS,
  DEFAULT_SOLID_PACK_SIZE,
  DEFAULT_LIQUID_PACK_SIZE,
  DAYS_PER_MONTH,
} from './time';

describe('time/numeric constants (#99)', () => {
  it('MS_PER_MINUTE is 60000', () => {
    expect(MS_PER_MINUTE).toBe(60 * 1000);
  });

  it('MS_PER_DAY is 86400000', () => {
    expect(MS_PER_DAY).toBe(1000 * 60 * 60 * 24);
  });

  it('NEVER_DEPLETES_DAYS is 999', () => {
    expect(NEVER_DEPLETES_DAYS).toBe(999);
  });

  it('REMINDER_POLL_INTERVAL_MS is 5000', () => {
    expect(REMINDER_POLL_INTERVAL_MS).toBe(5000);
  });

  it('DEFAULT_SNOOZE_MINUTES is 10', () => {
    expect(DEFAULT_SNOOZE_MINUTES).toBe(10);
  });

  it('NOTIFICATION_IMMEDIATE_OFFSET_MS is 1000', () => {
    expect(NOTIFICATION_IMMEDIATE_OFFSET_MS).toBe(1000);
  });

  it('CRITICAL_ALARM_FIRE_HOUR is 9', () => {
    expect(CRITICAL_ALARM_FIRE_HOUR).toBe(9);
  });

  it('TOAST_DURATION_MS is 4000', () => {
    expect(TOAST_DURATION_MS).toBe(4000);
  });

  it('PHARMACY_PERSIST_DEBOUNCE_MS is 400', () => {
    expect(PHARMACY_PERSIST_DEBOUNCE_MS).toBe(400);
  });

  it('SW_READY_TIMEOUT_MS is 2000', () => {
    expect(SW_READY_TIMEOUT_MS).toBe(2000);
  });

  it('VISUAL_RANGE_MULTIPLIER is 3', () => {
    expect(VISUAL_RANGE_MULTIPLIER).toBe(3);
  });

  it('MIN_VISUAL_RANGE_DAYS is 20', () => {
    expect(MIN_VISUAL_RANGE_DAYS).toBe(20);
  });

  it('MAX_LOG_ROWS is 15', () => {
    expect(MAX_LOG_ROWS).toBe(15);
  });

  it('DEFAULT_SOLID_PACK_SIZE is 30', () => {
    expect(DEFAULT_SOLID_PACK_SIZE).toBe(30);
  });

  it('DEFAULT_LIQUID_PACK_SIZE is 100', () => {
    expect(DEFAULT_LIQUID_PACK_SIZE).toBe(100);
  });

  it('DAYS_PER_MONTH is 30', () => {
    expect(DAYS_PER_MONTH).toBe(30);
  });
});
