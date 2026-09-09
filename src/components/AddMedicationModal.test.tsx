/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddMedicationModal } from './AddMedicationModal';
import type { Medication } from '../types';

// Mock playNotificationSound so the sound-option buttons don't touch
// the Web Audio API during tests.
vi.mock('../utils/sound', () => ({
  playNotificationSound: vi.fn(),
  NOTIFICATION_SOUND_OPTIONS: [
    { id: 'classic_chime', name: 'نغمة كلاسيكية', description: 'd', icon: '🔔' },
    { id: 'gentle_bell', name: 'جرس هادئ', description: 'd', icon: '✨' },
    { id: 'marimba', name: 'ماريمبا', description: 'd', icon: '🪵' },
    { id: 'digital_beep', name: 'نغمة رقمية', description: 'd', icon: '📱' },
    { id: 'harp', name: 'قيثارة', description: 'd', icon: '🎵' },
    { id: 'radar', name: 'رادار', description: 'd', icon: '📡' },
  ],
}));

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

/** Props for the modal in "open" state. */
function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onSave: vi.fn(),
    initialData: null,
    ...overrides,
  };
}

describe('AddMedicationModal — noStrips edit preserves packageSize (#14)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('editing a noStrips med shows the actual packageSize in the input, not "3"', () => {
    // A noStrips med: packageSize 15, no stripsPerBox/pillsPerStrip.
    const noStripsMed = makeMed({
      packageSize: 15,
      stripsPerBox: undefined,
      pillsPerStrip: undefined,
    });

    render(<AddMedicationModal {...baseProps({ initialData: noStripsMed })} />);

    // In noStrips mode, the "عدد الأقراص في العلبة" input reuses the
    // stripsPerBox state. Before the #14 fix it showed "3" (the
    // `initialData.stripsPerBox || 3` fallback); now it shows "15".
    const pillsPerBoxInput = screen.getByDisplayValue('15');
    expect(pillsPerBoxInput).toBeInTheDocument();

    // The "حجم العلبة" preview also shows 15.
    expect(screen.getByText(/15/)).toBeInTheDocument();
  });

  it('saving a noStrips edit preserves packageSize 15 (does not rewrite to 3)', () => {
    const noStripsMed = makeMed({
      id: 'med-nostrps',
      packageSize: 15,
      stripsPerBox: undefined,
      pillsPerStrip: undefined,
    });
    const onSave = vi.fn();

    render(
      <AddMedicationModal
        {...baseProps({ initialData: noStripsMed, onSave })}
      />
    );

    // Submit without touching the input.
    fireEvent.click(screen.getByText('حفظ التعديلات'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedData = onSave.mock.calls[0][0];
    // packageSize must still be 15, not 3.
    expect(savedData.packageSize).toBe(15);
    // stripsPerBox/pillsPerStrip must be undefined (noStrips).
    expect(savedData.stripsPerBox).toBeUndefined();
    expect(savedData.pillsPerStrip).toBeUndefined();
  });

  it('editing a strips med shows the real stripsPerBox and pillsPerStrip', () => {
    const stripsMed = makeMed({
      packageSize: 30,
      stripsPerBox: 3,
      pillsPerStrip: 10,
    });

    render(<AddMedicationModal {...baseProps({ initialData: stripsMed })} />);

    // stripsPerBox = 3, pillsPerStrip = 10, packageSize = 30
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();
  });

  it('adding a new noStrips med uses the entered pills-per-box as packageSize', () => {
    const onSave = vi.fn();
    render(<AddMedicationModal {...baseProps({ onSave })} />);

    // Toggle the "بدون أشرطة" checkbox.
    const noStripsCheckbox = screen.getByLabelText(/بدون أشرطة/);
    fireEvent.click(noStripsCheckbox);

    // The pills-per-box input is the one with placeholder "مثال: 15".
    // It shows the current stripsPerBox state (default "3" for a new med).
    const pillsPerBoxInput = screen.getByPlaceholderText('مثال: 15');
    fireEvent.change(pillsPerBoxInput, { target: { value: '20' } });

    // Enter a name so validation passes.
    const nameInput = screen.getByPlaceholderText(/بانادول|كونكور/);
    fireEvent.change(nameInput, { target: { value: 'NewNoStrips' } });

    // Submit.
    fireEvent.click(screen.getByText('إضافة الدواء'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedData = onSave.mock.calls[0][0];
    expect(savedData.packageSize).toBe(20);
    expect(savedData.stripsPerBox).toBeUndefined();
  });
});

/**
 * #32 — the `onAddLog` prop was removed from ConsumptionLogView. This
 * test verifies the component renders without it and doesn't crash.
 */
describe('ConsumptionLogView — onAddLog prop removed (#32)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders without an onAddLog prop (the dead prop is gone)', async () => {
    const { ConsumptionLogView } = await import('./ConsumptionLogView');
    render(
      <ConsumptionLogView
        medications={[]}
        logs={[]}
        onRestoreDose={vi.fn()}
        showToast={vi.fn()}
      />
    );
    // The header is always rendered.
    expect(screen.getByText('سجل الاستهلاك التلقائي')).toBeInTheDocument();
  });
});
