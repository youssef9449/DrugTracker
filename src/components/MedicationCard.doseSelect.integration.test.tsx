/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Phase 3A integration: MedicationCard Take Dose → SelectDoseModal → explicit doseId.
 * Mirrors App.tsx handleConsumeDose multi-dose branching without mounting full App.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MedicationCard } from './MedicationCard';
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
    autoDeductEnabled: true,
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

function makeLegacy(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-legacy',
    name: 'Legacy Med',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '20:00',
    ...overrides,
  };
}

/**
 * Same multi-dose decision as App.handleConsumeDose:
 * multi without doseId → open selector; otherwise forward to onFinal.
 */
function ManualConsumeHarness({
  medication,
  onFinal,
}: {
  medication: Medication;
  onFinal: (medicationId: string, doseId?: string) => void;
}) {
  const [selectDoseMed, setSelectDoseMed] = useState<Medication | null>(null);

  const handleConsumeDose = (medicationId: string, doseId?: string) => {
    const isMulti =
      Array.isArray(medication.doseSchedule) && medication.doseSchedule.length > 1;
    if (isMulti && !doseId) {
      setSelectDoseMed(medication);
      return;
    }
    const resolvedDoseId =
      doseId ??
      (Array.isArray(medication.doseSchedule) && medication.doseSchedule.length === 1
        ? medication.doseSchedule[0].id
        : undefined);
    setSelectDoseMed(null);
    onFinal(medicationId, resolvedDoseId);
  };

  const noop = () => {};

  return (
    <>
      <MedicationCard
        medication={medication}
        onOpenRefill={noop}
        onEdit={noop}
        onDelete={noop}
        onToggleAutoDeduct={noop}
        onConsumeDose={handleConsumeDose}
      />
      <SelectDoseModal
        isOpen={Boolean(selectDoseMed)}
        medication={selectDoseMed}
        onSelect={(medId, doseId) => handleConsumeDose(medId, doseId)}
        onClose={() => setSelectDoseMed(null)}
      />
    </>
  );
}

afterEach(() => cleanup());

describe('MedicationCard → SelectDoseModal integration (Phase 3A)', () => {
  it('opens selector on Take Dose and selecting d2 passes doseId=d2 (not first slot)', () => {
    const onFinal = vi.fn();
    render(<ManualConsumeHarness medication={makeMulti()} onFinal={onFinal} />);

    // Generic Take Dose — no doseId from the card.
    const takeBtn = screen.getByTitle(/تناول جرعة/);
    fireEvent.click(takeBtn);

    // Selector must open with all three slots.
    expect(screen.getByText(/اختر الجرعة التي تناولتها/)).toBeInTheDocument();
    const doseButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'));
    expect(doseButtons.map((b) => b.getAttribute('data-dose-id'))).toEqual([
      'd1',
      'd2',
      'd3',
    ]);

    // Explicitly pick non-first slot d2.
    const d2 = doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd2');
    expect(d2).toBeTruthy();
    fireEvent.click(d2!);

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith('med-multi', 'd2');
    // Never auto-selected d1.
    expect(onFinal).not.toHaveBeenCalledWith('med-multi', 'd1');
  });

  it('does not call onFinal when Take Dose only opens the selector', () => {
    const onFinal = vi.fn();
    render(<ManualConsumeHarness medication={makeMulti()} onFinal={onFinal} />);
    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    expect(onFinal).not.toHaveBeenCalled();
    expect(screen.getByText(/اختر الجرعة التي تناولتها/)).toBeInTheDocument();
  });

  it('consumed slot is disabled; unconsumed slot still selectable', () => {
    const today = getTodayDateString();
    const onFinal = vi.fn();
    render(
      <ManualConsumeHarness
        medication={makeMulti({ doseConsumption: { d1: today } })}
        onFinal={onFinal}
      />
    );
    fireEvent.click(screen.getByTitle(/تناول جرعة/));

    const d1 = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-dose-id') === 'd1');
    const d2 = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-dose-id') === 'd2');
    expect(d1).toBeDisabled();
    fireEvent.click(d1!);
    expect(onFinal).not.toHaveBeenCalled();

    expect(d2).not.toBeDisabled();
    fireEvent.click(d2!);
    expect(onFinal).toHaveBeenCalledWith('med-multi', 'd2');
  });

  it('shows all-consumed state and does not offer selectable slots', () => {
    const today = getTodayDateString();
    const onFinal = vi.fn();
    render(
      <ManualConsumeHarness
        medication={makeMulti({
          doseConsumption: { d1: today, d2: today, d3: today },
        })}
        onFinal={onFinal}
      />
    );
    // Card shows completed badge (no take button) when all slots consumed.
    expect(screen.queryByTitle(/^تناول جرعة/)).toBeNull();
    expect(screen.getByTitle(/تم تناول جرعة اليوم/)).toBeInTheDocument();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('legacy medication Take Dose calls onFinal without opening selector', () => {
    const onFinal = vi.fn();
    render(<ManualConsumeHarness medication={makeLegacy()} onFinal={onFinal} />);
    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).toBeNull();
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith('med-legacy', undefined);
  });

  it('single-dose schedule passes the only doseId without selector', () => {
    const onFinal = vi.fn();
    const med = makeMulti({
      doseSchedule: [{ id: 'only', amount: 1, time: '09:00' }],
      dosesPerDay: 1,
      dailyDose: 1,
    });
    render(<ManualConsumeHarness medication={med} onFinal={onFinal} />);
    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).toBeNull();
    expect(onFinal).toHaveBeenCalledWith('med-multi', 'only');
  });

  it('closing the selector without selecting does not consume', () => {
    const onFinal = vi.fn();
    render(<ManualConsumeHarness medication={makeMulti()} onFinal={onFinal} />);
    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    expect(screen.getByText(/اختر الجرعة التي تناولتها/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('إغلاق'));
    expect(onFinal).not.toHaveBeenCalled();
  });
});
