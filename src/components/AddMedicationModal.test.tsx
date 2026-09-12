/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddMedicationModal } from './AddMedicationModal';
import type { Medication } from '../types';

// Mock sound module — only playSuccessChime + stopAllSounds remain.
vi.mock('../utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
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


/** The unit <select> (قرص/كبسولة/مل/...), not the dosesPerDay select. */
function getUnitSelect(): HTMLSelectElement {
  const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
  const unit = selects.find((s) =>
    Array.from(s.options).some((o) => o.value === 'مل' || o.value === 'قرص')
  );
  if (!unit) throw new Error('unit select not found');
  return unit;
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

    // The "حجم العلبة" preview also shows 15 (may appear in more than one node).
    expect(screen.getAllByText(/15/).length).toBeGreaterThanOrEqual(1);
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

  it('non-solid unit: package size field can be cleared without snapping to 1', () => {
    // Regression test for the bug where selecting a non-pill unit (مل/جرعة/كيس)
    // made the package-size field impossible to clear — clearing it snapped
    // back to "1" because of `Math.max(1, parseInt(...) || 1)`.
    render(<AddMedicationModal {...baseProps()} />);

    // Switch the unit to a liquid (مل) — this reveals the non-solid
    // package-size input (placeholder "مثال: 100 أو 120 مل").
    const unitSelect = getUnitSelect();
    fireEvent.change(unitSelect, { target: { value: 'مل' } });

    const pkgInput = screen.getByPlaceholderText('مثال: 100 أو 120 مل') as HTMLInputElement;
    // After switching to مل, the default is 100.
    expect(pkgInput).toHaveValue(100);

    // Clear the field — it must become empty, NOT snap to "1".
    // (A number input renders an empty value as '' in .value.)
    fireEvent.change(pkgInput, { target: { value: '' } });
    expect(pkgInput.value).toBe('');

    // Typing a new value works normally.
    fireEvent.change(pkgInput, { target: { value: '120' } });
    expect(pkgInput).toHaveValue(120);
  });

  it('non-solid unit: edited package size is saved correctly', () => {
    const onSave = vi.fn();
    render(<AddMedicationModal {...baseProps({ onSave })} />);

    // Switch to liquid (مل).
    fireEvent.change(getUnitSelect(), { target: { value: 'مل' } });

    const pkgInput = screen.getByPlaceholderText('مثال: 100 أو 120 مل');
    // Change from the default 100 to 120.
    fireEvent.change(pkgInput, { target: { value: '120' } });

    // Enter a name + valid daily dose so validation passes.
    fireEvent.change(screen.getByPlaceholderText(/بانادول|كونكور/), { target: { value: 'Sirop' } });
    // dailyDose default for مل is '5' (set by handleUnitChange).
    // Submit.
    fireEvent.click(screen.getByText('إضافة الدواء'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedData = onSave.mock.calls[0][0];
    expect(savedData.unit).toBe('مل');
    expect(savedData.packageSize).toBe(120);
    expect(savedData.stripsPerBox).toBeUndefined();
    expect(savedData.pillsPerStrip).toBeUndefined();
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

describe('AddMedicationModal — multi-dose schedule (Phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows one dose row by default for a new medication', () => {
    render(<AddMedicationModal {...baseProps()} />);
    expect(screen.getByText('الجرعة 1')).toBeInTheDocument();
    expect(screen.queryByText('الجرعة 2')).not.toBeInTheDocument();
  });

  it('changing dosesPerDay from 1 → 3 creates three rows', () => {
    render(<AddMedicationModal {...baseProps()} />);
    // dosesPerDay is the only <select> whose options are 1..6
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const doseCountSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === '6')
    );
    expect(doseCountSelect).toBeTruthy();
    fireEvent.change(doseCountSelect!, { target: { value: '3' } });
    expect(screen.getByText('الجرعة 1')).toBeInTheDocument();
    expect(screen.getByText('الجرعة 2')).toBeInTheDocument();
    expect(screen.getByText('الجرعة 3')).toBeInTheDocument();
  });

  it('edit mode loads existing multi-dose schedule', () => {
    const med = makeMed({
      dailyDose: 4,
      dosesPerDay: 3,
      doseSchedule: [
        { id: 'd1', amount: 2, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
        { id: 'd3', amount: 1, time: '21:00' },
      ],
      reminderTime: '08:00',
    });
    render(<AddMedicationModal {...baseProps({ initialData: med })} />);
    expect(screen.getByText('الجرعة 1')).toBeInTheDocument();
    expect(screen.getByText('الجرعة 2')).toBeInTheDocument();
    expect(screen.getByText('الجرعة 3')).toBeInTheDocument();
    const amountTwos = screen.getAllByDisplayValue('2');
    expect(amountTwos.length).toBeGreaterThanOrEqual(1);
  });

  it('legacy med without schedule maps to one dose in the UI', () => {
    const med = makeMed({
      dailyDose: 2,
      reminderTime: '20:00',
      dosesPerDay: undefined,
      doseSchedule: undefined,
    });
    render(<AddMedicationModal {...baseProps({ initialData: med })} />);
    expect(screen.getByText('الجرعة 1')).toBeInTheDocument();
    expect(screen.queryByText('الجرعة 2')).not.toBeInTheDocument();
    const amountTwos = screen.getAllByDisplayValue('2');
    expect(amountTwos.length).toBeGreaterThanOrEqual(1);
  });

  it('saving persists doseSchedule and derived dailyDose without changing stock fields', () => {
    const med = makeMed({
      id: 'med-edit-stock',
      currentPills: 42,
      lastSyncDate: '2024-06-01',
      lastConsumedDate: '2024-06-01',
      dailyDose: 1,
      reminderTime: '09:00',
    });
    const onSave = vi.fn();
    render(
      <AddMedicationModal {...baseProps({ initialData: med, onSave })} />
    );

    const nameInput = screen.getByDisplayValue('Test');
    fireEvent.change(nameInput, { target: { value: 'Test Updated' } });
    fireEvent.click(screen.getByText('حفظ التعديلات'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.currentPills).toBe(42);
    expect(saved.lastSyncDate).toBe('2024-06-01');
    expect(saved.doseSchedule).toHaveLength(1);
    expect(saved.dosesPerDay).toBe(1);
    expect(saved.dailyDose).toBe(1);
  });

  it('invalid zero amount prevents saving', () => {
    const onSave = vi.fn();
    render(<AddMedicationModal {...baseProps({ onSave })} />);
    const nameInput = screen.getByPlaceholderText(/بانادول|كونكور/);
    fireEvent.change(nameInput, { target: { value: 'BadDose' } });

    const amountInputs = screen.getAllByPlaceholderText('مثال: 1');
    const scheduleAmount = amountInputs[0] as HTMLInputElement;
    fireEvent.change(scheduleAmount, { target: { value: '0' } });

    fireEvent.click(screen.getByText('إضافة الدواء'));
    expect(onSave).not.toHaveBeenCalled();
  });
});
