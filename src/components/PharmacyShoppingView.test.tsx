/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PharmacyShoppingView } from './PharmacyShoppingView';
import type { Medication, PharmacySettings } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  // lastSyncDate defaults to today so effectiveCurrentPills() ===
  // currentPills (no projection); tests set their own lastSyncDate to
  // exercise the dynamic balance.
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 2,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    ...overrides,
  };
}

const defaultSettings: PharmacySettings = {
  pharmacyPhone: '01012345678',
  pharmacyName: 'Test Pharmacy',
  customerCode: '',
  defaultDurationDays: 30,
  customQuantities: {},
  address: '',
  contactPhone: '',
};

function renderView(overrides: Record<string, unknown> = {}) {
  const props = {
    medications: [] as Medication[],
    settings: defaultSettings,
    onUpdateSettings: vi.fn(),
    onOpenSettings: vi.fn(),
    onConfirmRefill: vi.fn(),
    showToast: vi.fn(),
    ...overrides,
  };
  return render(<PharmacyShoppingView {...props} />);
}

// Wave 13 #123: pin system time so getTodayDateString() (used by
// makeMed's lastSyncDate default) resolves to a deterministic date.
// Only Date is faked so React/testing-library's internal scheduling
// keeps working unchanged. These top-level hooks run before/after every
// test in this file, including those in nested describe blocks.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Find the checkbox toggle button for a given med name. */
function getCheckboxFor(medName: string): HTMLElement {
  // The med name is in an <h4>; the checkbox button is the
  // preceding sibling button that contains a CheckSquare/Square icon.
  const nameEl = screen.getByText(medName);
  const card = nameEl.closest('div.rounded-2xl')!;
  const checkBtn = card.querySelector('button')!;
  return checkBtn;
}

/** Click the "تعبئة" refill button for the first displayed med. */
function clickRefillButton() {
  const btn = screen.getByRole('button', { name: /تعبئة/ });
  fireEvent.click(btn);
}

describe('PharmacyShoppingView — deselection preservation (#20)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('manual deselect is preserved when displayList changes (a new med is added)', () => {
    const medA = makeMed({ id: 'med-a', name: 'Med A', currentPills: 1, dailyDose: 1 });
    const medB = makeMed({ id: 'med-b', name: 'Med B', currentPills: 2, dailyDose: 1 });
    const { rerender } = renderView({ medications: [medA, medB] });

    // Both should be selected initially (2/2).
    expect(screen.getByText(/2 من 2/)).toBeInTheDocument();

    // Deselect medA via its checkbox.
    fireEvent.click(getCheckboxFor('Med A'));

    // Now 1/2.
    expect(screen.getByText(/1 من 2/)).toBeInTheDocument();

    // Add a new non-urgent med (not in the urgent-only displayList).
    const medC = makeMed({ id: 'med-c', name: 'Med C', currentPills: 50, dailyDose: 1 });
    rerender(
      <PharmacyShoppingView
        medications={[medA, medB, medC]}
        settings={defaultSettings}
        onUpdateSettings={vi.fn()}
        onOpenSettings={vi.fn()}
        onConfirmRefill={vi.fn()}
        showToast={vi.fn()}
      />
    );

    // #20: medA must STILL be deselected (not silently re-selected).
    // The displayList is still [medA, medB] (medC is sufficient, not
    // urgent), so the count should still be 1/2, not 2/2.
    expect(screen.getByText(/1 من 2/)).toBeInTheDocument();
  });

  it('"إلغاء" (deselect all) persists across displayList changes', () => {
    const medA = makeMed({ id: 'med-a', name: 'Med A', currentPills: 1, dailyDose: 1 });
    const { rerender } = renderView({ medications: [medA] });

    // Deselect all.
    fireEvent.click(screen.getByText('إلغاء'));
    expect(screen.getByText(/0 من 1/)).toBeInTheDocument();

    // Add another urgent med.
    const medB = makeMed({ id: 'med-b', name: 'Med B', currentPills: 1, dailyDose: 1 });
    rerender(
      <PharmacyShoppingView
        medications={[medA, medB]}
        settings={defaultSettings}
        onUpdateSettings={vi.fn()}
        onOpenSettings={vi.fn()}
        onConfirmRefill={vi.fn()}
        showToast={vi.fn()}
      />
    );

    // medA should still be deselected; medB should be auto-selected
    // (it's new, not in deselectedIds). So count is 1/2.
    expect(screen.getByText(/1 من 2/)).toBeInTheDocument();
  });

  it('"تحديد الكل" (select all) clears the deselect records', () => {
    const medA = makeMed({ id: 'med-a', name: 'Med A', currentPills: 1, dailyDose: 1 });
    const { rerender } = renderView({ medications: [medA] });

    // Deselect all.
    fireEvent.click(screen.getByText('إلغاء'));
    expect(screen.getByText(/0 من 1/)).toBeInTheDocument();

    // Select all.
    fireEvent.click(screen.getByText('تحديد الكل'));
    expect(screen.getByText(/1 من 1/)).toBeInTheDocument();

    // Add a new med — it should be auto-selected too (deselects
    // were cleared).
    const medB = makeMed({ id: 'med-b', name: 'Med B', currentPills: 1, dailyDose: 1 });
    rerender(
      <PharmacyShoppingView
        medications={[medA, medB]}
        settings={defaultSettings}
        onUpdateSettings={vi.fn()}
        onOpenSettings={vi.fn()}
        onConfirmRefill={vi.fn()}
        showToast={vi.fn()}
      />
    );

    // Both should be selected (2/2) because select-all cleared the
    // deselect records.
    expect(screen.getByText(/2 من 2/)).toBeInTheDocument();
  });
});

describe('PharmacyShoppingView — refilledIds pruning (#34)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('refilled chip disappears when the med is removed from the list', () => {
    const medA = makeMed({ id: 'med-a', name: 'Med A', currentPills: 1, dailyDose: 1 });
    const { rerender } = renderView({
      medications: [medA],
      onConfirmRefill: vi.fn(),
    });

    // Tap "تعبئة" to mark medA as refilled.
    clickRefillButton();

    // The confirmation chip should appear.
    expect(screen.getByText(/تمت التعبئة/)).toBeInTheDocument();

    // Remove medA from the medications list (simulating deletion).
    rerender(
      <PharmacyShoppingView
        medications={[]}
        settings={defaultSettings}
        onUpdateSettings={vi.fn()}
        onOpenSettings={vi.fn()}
        onConfirmRefill={vi.fn()}
        showToast={vi.fn()}
      />
    );

    // The refilled chip should be gone (the med is no longer
    // displayed — refilledIds was pruned by the reconciliation effect).
    expect(screen.queryByText(/تمت التعبئة/)).toBeNull();
  });

  it('a med that returns to the list after being refilled and removed can be refilled again', () => {
    const medA = makeMed({ id: 'med-a', name: 'Med A', currentPills: 1, dailyDose: 1 });
    const { rerender } = renderView({ medications: [medA] });

    // Refill medA.
    clickRefillButton();
    expect(screen.getByText(/تمت التعبئة/)).toBeInTheDocument();

    // Remove medA.
    rerender(
      <PharmacyShoppingView
        medications={[]}
        settings={defaultSettings}
        onUpdateSettings={vi.fn()}
        onOpenSettings={vi.fn()}
        onConfirmRefill={vi.fn()}
        showToast={vi.fn()}
      />
    );

    // Bring medA back.
    rerender(
      <PharmacyShoppingView
        medications={[medA]}
        settings={defaultSettings}
        onUpdateSettings={vi.fn()}
        onOpenSettings={vi.fn()}
        onConfirmRefill={vi.fn()}
        showToast={vi.fn()}
      />
    );

    // #34: the "تعبئة" button should be back (not the confirmation
    // chip), because refilledIds was pruned when medA left the list.
    expect(screen.getByRole('button', { name: /تعبئة/ })).toBeInTheDocument();
    expect(screen.queryByText(/تمت التعبئة/)).toBeNull();
  });

  it('clicking WhatsApp send button opens the send modal with analyzed order quantities', () => {
    const medA = makeMed({ id: 'med-a', name: 'كونكور 5', currentPills: 2, dailyDose: 1, stripsPerBox: 3, pillsPerStrip: 10 });
    renderView({ medications: [medA] });

    const sendBtn = screen.getByRole('button', { name: /إرسال لواتساب/ });
    fireEvent.click(sendBtn);

    // Modal opens
    expect(screen.getByText('إرسال الطلب للصيدلية')).toBeInTheDocument();
    expect(screen.getByText(/فتح محادثة واتساب الآن/)).toBeInTheDocument();
    expect(screen.getAllByText('كونكور 5').length).toBeGreaterThanOrEqual(2);
  });

  it('passes analyzed order items when opening settings from the top card', () => {
    const medA = makeMed({ id: 'med-a', name: 'كونكور 5', currentPills: 2, dailyDose: 1 });
    const onOpenSettings = vi.fn();
    renderView({ medications: [medA], onOpenSettings });

    const editBtn = screen.getByRole('button', { name: /تعديل/ });
    fireEvent.click(editBtn);

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    const passedItems = onOpenSettings.mock.calls[0][0];
    expect(passedItems).toBeDefined();
    expect(passedItems.length).toBe(1);
    expect(passedItems[0].name).toBe('كونكور 5');
  });
});

