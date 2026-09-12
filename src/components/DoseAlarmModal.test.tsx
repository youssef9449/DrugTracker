/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DoseAlarmModal } from './DoseAlarmModal';
import type { Medication } from '../types';

// Mock sound module — only playSuccessChime + stopAllSounds remain.
vi.mock('../utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-alarm',
    name: 'Test Med',
    currentPills: 5,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    reminderEnabled: true,
    reminderTime: '09:00',
    ...overrides,
  };
}

describe('DoseAlarmModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the medication name + dose info when open', () => {
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={() => {}}
        onSnooze={() => {}}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText('Test Med')).toBeInTheDocument();
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={() => {}}
        onSnooze={() => {}}
        onDismiss={onDismiss}
      />
    );
    // Click the first dismiss-like button (there may be multiple).
    const buttons = screen.getAllByRole('button');
    // The modal has take/snooze/dismiss buttons — click the last one (dismiss).
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onSnooze when the snooze button is clicked', () => {
    const onSnooze = vi.fn();
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={() => {}}
        onSnooze={onSnooze}
        onDismiss={() => {}}
      />
    );
    const snoozeBtn = screen.getByText(/غفوة|تأجيل/);
    fireEvent.click(snoozeBtn);
    expect(onSnooze).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when isOpen is false', () => {
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={false}
        medication={med}
        onTakeDose={() => {}}
        onSnooze={() => {}}
        onDismiss={() => {}}
      />
    );
    expect(screen.queryByText('Test Med')).toBeNull();
  });

  it('passes the triggering doseId to onTakeDose', () => {
    const onTakeDose = vi.fn();
    const med = makeMed({
      doseSchedule: [
        { id: 'slot-a', amount: 2, time: '08:00' },
        { id: 'slot-b', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
      dailyDose: 3,
    });
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        doseId="slot-b"
        onTakeDose={onTakeDose}
        onSnooze={() => {}}
        onDismiss={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('alarm-take-dose'));
    expect(onTakeDose).toHaveBeenCalledTimes(1);
    expect(onTakeDose.mock.calls[0][0].id).toBe('med-alarm');
    expect(onTakeDose.mock.calls[0][1]).toBe('slot-b');
  });

  it('legacy alarm without doseId still calls onTakeDose with undefined doseId', () => {
    const onTakeDose = vi.fn();
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={onTakeDose}
        onSnooze={() => {}}
        onDismiss={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('alarm-take-dose'));
    expect(onTakeDose).toHaveBeenCalledWith(med, undefined);
  });
});
