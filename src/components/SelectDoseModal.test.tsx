/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SelectDoseModal } from './SelectDoseModal';
import {
  relativeDoseDayLabel,
  sortDoseSelectItems,
} from '../utils/doseSelectDisplay';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-multi',
    name: 'Multi Med',
    currentPills: 30,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    reminderEnabled: true,
    reminderTime: '08:00',
    doseSchedule: [
      { id: 'd1', amount: 2, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 1, time: '21:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

describe('relativeDoseDayLabel', () => {
  it('labels today as اليوم', () => {
    expect(relativeDoseDayLabel('2026-09-13', '2026-09-13')).toBe('اليوم');
  });

  it('labels tomorrow as غدًا', () => {
    expect(relativeDoseDayLabel('2026-09-14', '2026-09-13')).toBe('غدًا');
  });

  it('labels other days with Arabic weekday (not full long date)', () => {
    // 2026-09-15 is a Tuesday
    const label = relativeDoseDayLabel('2026-09-15', '2026-09-13');
    expect(label).not.toBe('اليوم');
    expect(label).not.toBe('غدًا');
    expect(label).not.toMatch(/2026/);
    expect(label.length).toBeGreaterThan(0);
  });
});

describe('sortDoseSelectItems', () => {
  it('same-day doses sort by time ascending and keep amount+id attached', () => {
    const items = sortDoseSelectItems([
      { dose: { id: 'd3', amount: 3, time: '21:00' }, eventDate: '2026-09-13' },
      { dose: { id: 'd1', amount: 2, time: '08:00' }, eventDate: '2026-09-13' },
      { dose: { id: 'd2', amount: 1, time: '14:00' }, eventDate: '2026-09-13' },
    ]);
    expect(items.map((i) => i.dose.id)).toEqual(['d1', 'd2', 'd3']);
    expect(items.map((i) => i.dose.amount)).toEqual([2, 1, 3]);
  });

  it('sorts by calendar date first, then time (not clock-only)', () => {
    // Later calendar day with earlier clock time must still sort later.
    const items = sortDoseSelectItems([
      { dose: { id: 'morning', amount: 1, time: '08:00' }, eventDate: '2026-09-14' },
      { dose: { id: 'night', amount: 2, time: '23:00' }, eventDate: '2026-09-13' },
      { dose: { id: 'afternoon', amount: 1, time: '14:00' }, eventDate: '2026-09-14' },
    ]);
    expect(items.map((i) => i.dose.id)).toEqual(['night', 'morning', 'afternoon']);
    expect(items.map((i) => i.eventDate)).toEqual([
      '2026-09-13',
      '2026-09-14',
      '2026-09-14',
    ]);
  });

  it('sorting does not use Arabic display text', () => {
    const items = sortDoseSelectItems([
      { dose: { id: 'b', amount: 1, time: '09:00' }, eventDate: '2026-09-15' },
      { dose: { id: 'a', amount: 1, time: '22:00' }, eventDate: '2026-09-13' },
    ]);
    expect(items[0].dose.id).toBe('a');
    expect(items[1].dose.id).toBe('b');
  });
});

describe('SelectDoseModal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0)); // local Sep 13 2026
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('lists doses with day + time (اليوم • Arabic time)', () => {
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/اختر الجرعة/)).toBeInTheDocument();
    const doseButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'));
    expect(doseButtons).toHaveLength(3);
    // Today label + formatted times
    expect(screen.getAllByText(/اليوم/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/اليوم • 8:00 ص/)).toBeInTheDocument();
    expect(screen.getByText(/اليوم • 2:00 م/)).toBeInTheDocument();
    expect(screen.getByText(/اليوم • 9:00 م/)).toBeInTheDocument();
    // Amounts stay visible
    expect(screen.getByText(/2 قرص/)).toBeInTheDocument();
  });

  it('orders unsorted schedule by time ascending for the same day', () => {
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti({
          doseSchedule: [
            { id: 'd3', amount: 1, time: '21:00' },
            { id: 'd1', amount: 2, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
          ],
        })}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    const ids = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'))
      .map((b) => b.getAttribute('data-dose-id'));
    expect(ids).toEqual(['d1', 'd2', 'd3']);
  });

  it('selecting dose B passes original doseId = d2', () => {
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const b = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd2');
    fireEvent.click(b!);
    expect(onSelect).toHaveBeenCalledWith('med-multi', 'd2');
  });

  it('selecting dose A passes doseId = d1', () => {
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const a = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd1');
    fireEvent.click(a!);
    expect(onSelect).toHaveBeenCalledWith('med-multi', 'd1');
  });

  it('marks consumed doses and blocks re-selection', () => {
    const today = getTodayDateString();
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti({ doseConsumption: { d1: today } })}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const a = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd1');
    expect(a).toBeDisabled();
    fireEvent.click(a!);
    expect(onSelect).not.toHaveBeenCalled();

    const b = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd2');
    expect(b).not.toBeDisabled();
  });

  it('shows all-consumed state when every slot is done', () => {
    const today = getTodayDateString();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti({
          doseConsumption: { d1: today, d2: today, d3: today },
        })}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/تم تناول جميع جرعات اليوم/)).toBeInTheDocument();
  });
});
