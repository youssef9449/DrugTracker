/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ConsumptionLogView } from './ConsumptionLogView';
import type { Medication, ConsumptionLog } from '../types';

function makeMed(id: string, name: string): Medication {
  return {
    id,
    name,
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
  };
}

const noop = vi.fn();
const emptyLogs: ConsumptionLog[] = [];

describe('ConsumptionLogView — derived selection (#69)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to the first medication when none was previously selected', () => {
    const meds = [makeMed('med-a', 'Med A'), makeMed('med-b', 'Med B')];
    render(
      <ConsumptionLogView
        medications={meds}
        logs={emptyLogs}
        onRestoreDose={noop}
        showToast={noop}
      />
    );
    const select = screen.getByLabelText('اختر الدواء') as HTMLSelectElement;
    expect(select.value).toBe('med-a');
  });

  it('falls back to the first medication when the stored selection is deleted (no effect thrash)', () => {
    // The component initializes selectedMedIdInput = medications[0]?.id = 'med-a'.
    // We simulate the user selecting 'med-b', then the parent removing 'med-b'
    // from the list. The derived `selectedMedId` must fall back to 'med-a'
    // WITHOUT a useEffect that mutates state in its own dep array (#69).
    const meds = [makeMed('med-a', 'Med A'), makeMed('med-b', 'Med B')];
    const { rerender } = render(
      <ConsumptionLogView
        medications={meds}
        logs={emptyLogs}
        onRestoreDose={noop}
        showToast={noop}
      />
    );
    const select = screen.getByLabelText('اختر الدواء') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'med-b' } });
    expect(select.value).toBe('med-b');

    // Parent removes 'med-b' from the list.
    rerender(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={emptyLogs}
        onRestoreDose={noop}
        showToast={noop}
      />
    );
    const selectAfter = screen.getByLabelText('اختر الدواء') as HTMLSelectElement;
    // Derived selection falls back to 'med-a' (the first remaining med).
    expect(selectAfter.value).toBe('med-a');
  });

  it('shows an empty-state when the medications list becomes empty', () => {
    const { rerender } = render(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={emptyLogs}
        onRestoreDose={noop}
        showToast={noop}
      />
    );
    rerender(
      <ConsumptionLogView
        medications={[]}
        logs={emptyLogs}
        onRestoreDose={noop}
        showToast={noop}
      />
    );
    // The select still renders but with no options; selectedMedId resolves to ''.
    const select = screen.getByLabelText('اختر الدواء') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.options).toHaveLength(0);
  });

  it('calls onRestoreDose with the derived (fallback) selection, not the stale stored one', () => {
    const onRestoreDose = vi.fn(() => true);
    const meds = [makeMed('med-a', 'Med A'), makeMed('med-b', 'Med B')];
    const { rerender } = render(
      <ConsumptionLogView
        medications={meds}
        logs={emptyLogs}
        onRestoreDose={onRestoreDose}
        showToast={noop}
      />
    );
    // User selects med-b, then med-b is deleted, then user clicks skip-dose.
    fireEvent.change(screen.getByLabelText('اختر الدواء'), { target: { value: 'med-b' } });
    rerender(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={emptyLogs}
        onRestoreDose={onRestoreDose}
        showToast={noop}
      />
    );
    fireEvent.click(screen.getByText(/إعادة الجرعة المخصومة/));
    // The call should target 'med-a' (the fallback), NOT 'med-b' (the stale
    // stored selection that no longer exists).
    expect(onRestoreDose).toHaveBeenCalledWith('med-a', expect.any(String), undefined);
  });
});

describe('ConsumptionLogView — multi-dose restore', () => {
  function makeMulti(): Medication {
    return {
      ...makeMed('med-multi', 'Multi Med'),
      dailyDose: 4,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 2, time: '20:00' },
      ],
      dosesPerDay: 3,
    };
  }

  afterEach(() => cleanup());

  it('shows dose selector and passes selected doseId (not dailyDose amount in handler)', () => {
    const onRestoreDose = vi.fn(() => true);
    render(
      <ConsumptionLogView
        medications={[makeMulti()]}
        logs={emptyLogs}
        onRestoreDose={onRestoreDose}
        showToast={noop}
      />
    );
    expect(screen.getByLabelText('اختر الجرعة')).toBeInTheDocument();
    // Default first slot d1
    fireEvent.click(screen.getByText(/إعادة الجرعة المخصومة/));
    expect(onRestoreDose).toHaveBeenCalledWith('med-multi', expect.any(String), 'd1');

    onRestoreDose.mockClear();
    fireEvent.change(screen.getByLabelText('اختر الجرعة'), { target: { value: 'd3' } });
    fireEvent.click(screen.getByText(/إعادة الجرعة المخصومة/));
    expect(onRestoreDose).toHaveBeenCalledWith('med-multi', expect.any(String), 'd3');
  });

  it('button preview shows selected slot amount not dailyDose', () => {
    render(
      <ConsumptionLogView
        medications={[makeMulti()]}
        logs={emptyLogs}
        onRestoreDose={noop}
        showToast={noop}
      />
    );
    // d1 amount 1
    expect(screen.getByText(/\(\+1 قرص\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('اختر الجرعة'), { target: { value: 'd3' } });
    expect(screen.getByText(/\(\+2 قرص\)/)).toBeInTheDocument();
  });
});
