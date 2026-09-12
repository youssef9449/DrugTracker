/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SelectDoseModal } from './SelectDoseModal';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-multi',
    name: 'Drug A',
    currentPills: 30,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
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

afterEach(() => cleanup());

describe('SelectDoseModal — Phase 3A explicit dose selection', () => {
  it('lists all configured doses with time and amount', () => {
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/اختر الجرعة/)).toBeInTheDocument();
    // Three dose buttons
    const doseButtons = screen.getAllByRole('button').filter((b) =>
      b.getAttribute('data-dose-id')
    );
    expect(doseButtons).toHaveLength(3);
    expect(doseButtons[0].getAttribute('data-dose-id')).toBe('d1');
    expect(doseButtons[1].getAttribute('data-dose-id')).toBe('d2');
    expect(doseButtons[2].getAttribute('data-dose-id')).toBe('d3');
    // Amounts appear in labels
    expect(screen.getByText(/2 قرص/)).toBeInTheDocument();
  });

  it('selecting dose B passes doseId = B (never auto-picks first pending)', () => {
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const b = screen.getAllByRole('button').find((btn) =>
      btn.getAttribute('data-dose-id') === 'd2'
    );
    expect(b).toBeTruthy();
    fireEvent.click(b!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('med-multi', 'd2');
  });

  it('selecting dose A passes doseId = A', () => {
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const a = screen.getAllByRole('button').find((btn) =>
      btn.getAttribute('data-dose-id') === 'd1'
    );
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
    const a = screen.getAllByRole('button').find((btn) =>
      btn.getAttribute('data-dose-id') === 'd1'
    );
    expect(a).toBeDisabled();
    fireEvent.click(a!);
    expect(onSelect).not.toHaveBeenCalled();

    const b = screen.getAllByRole('button').find((btn) =>
      btn.getAttribute('data-dose-id') === 'd2'
    );
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
    const doseButtons = screen.queryAllByRole('button').filter((b) =>
      b.getAttribute('data-dose-id')
    );
    expect(doseButtons).toHaveLength(0);
  });
});
