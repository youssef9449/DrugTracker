/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PharmacyShoppingView } from '@/components/PharmacyShoppingView';
import type { Medication, PharmacySettings } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
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
    ...overrides,
  };
}

const defaultSettings: PharmacySettings = {
  defaultDurationDays: 30,
  pharmacies: [],
  selectedPharmacyId: '',
  whatsappContacts: [],
  whatsappAddresses: [],
  selectedWhatsappContactIds: [],
  selectedWhatsappAddressIds: [],
};

function renderView(overrides: Record<string, unknown> = {}) {
  const props = {
    medications: [] as Medication[],
    settings: defaultSettings,
    onUpdateSettings: vi.fn(),
    showToast: vi.fn(),
    onOpenUserContactsSettings: vi.fn(),
    ...overrides,
  };
  return render(<PharmacyShoppingView {...props} />);
}

// Wave 13 #123: pin system time so getTodayDateString() (used by
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
        showToast={vi.fn()}
      />
    );

    // Both should be selected (2/2) because select-all cleared the
    // deselect records.
    expect(screen.getByText(/2 من 2/)).toBeInTheDocument();
  });

  it('removes a medication from the shopping list without deleting it', () => {
    const med = makeMed({ id: 'med-remove', name: 'Remove Me', currentPills: 1, dailyDose: 1 });
    renderView({ medications: [med] });

    fireEvent.click(screen.getByRole('button', { name: 'إزالة Remove Me من قائمة الشراء' }));

    expect(screen.queryByText('Remove Me')).toBeNull();
    expect(screen.getByText(/0 من 0/)).toBeInTheDocument();
  });

  it('shows previously removed medications when switching to all medications', () => {
    const med = makeMed({ id: 'med-restore', name: 'Restore Me', currentPills: 1, dailyDose: 1 });
    renderView({ medications: [med] });

    fireEvent.click(screen.getByRole('button', { name: 'إزالة Restore Me من قائمة الشراء' }));
    expect(screen.queryByText('Restore Me')).toBeNull();

    fireEvent.click(screen.getByText('كل الأدوية'));

    expect(screen.getByText('Restore Me')).toBeInTheDocument();
    expect(screen.getByText(/1 من 1/)).toBeInTheDocument();
  });
});

describe('PharmacyShoppingView — refill actions', () => {
  afterEach(() => cleanup());

  it('does not render refill or undo actions for medications', () => {
    const med = makeMed({ currentPills: 1, dailyDose: 1 });
    renderView({ medications: [med] });

    expect(screen.queryByRole('button', { name: /تعبئة/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /تراجع/ })).toBeNull();
    expect(screen.queryByText(/تمت التعبئة/)).toBeNull();
  });

  it('keeps the period quantity unchanged when switching display units', () => {
    const med = makeMed({
      currentPills: 1,
      dailyDose: 1,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
    });
    renderView({ medications: [med] });

    expect(screen.getByText('3 أشرطة')).toBeInTheDocument();
    expect(screen.getByText('الإجمالي: علبة واحدة (30 قرصاً)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'علبة' }));

    expect(screen.getByText('علبة واحدة')).toBeInTheDocument();
    expect(screen.getByText('الإجمالي: علبة واحدة (30 قرصاً)')).toBeInTheDocument();
  });

  it('allows a custom quantity to combine box + strip quantities', () => {
    const med = makeMed({
      currentPills: 1,
      dailyDose: 1,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
    });
    renderView({ medications: [med] });

    fireEvent.click(screen.getByRole('button', { name: 'كمية محددة' }));
    const stripQty = screen.getByRole('spinbutton', { name: /كمية Test Med شريط/ });
    expect(stripQty).toHaveValue(3);

    fireEvent.click(screen.getByRole('button', { name: 'علبة' }));
    const boxQty = screen.getByRole('spinbutton', { name: /كمية Test Med علبة/ });
    expect(boxQty).toHaveValue(1);

    expect(screen.getByText('الإجمالي: علبة واحدة و 3 أشرطة (60 قرصاً)')).toBeInTheDocument();

    fireEvent.change(boxQty, { target: { value: '2' } });
    expect(screen.getByText('الإجمالي: علبتين و 3 أشرطة (90 قرصاً)')).toBeInTheDocument();
  });

  it('allows a custom sachet quantity to combine bags + box', () => {
    const med = makeMed({
      id: 'sachet-med',
      name: 'فوار',
      currentPills: 1,
      dailyDose: 1,
      unit: 'كيس',
      packageSize: 10,
    });
    renderView({ medications: [med] });

    fireEvent.click(screen.getByRole('button', { name: 'كمية محددة' }));
    const bagQty = screen.getByRole('spinbutton', { name: /كمية فوار كيس/ });
    expect(bagQty).toHaveValue(30);

    fireEvent.click(screen.getByRole('button', { name: 'علبة' }));
    const boxQty = screen.getByRole('spinbutton', { name: /كمية فوار علبة/ });
    expect(boxQty).toHaveValue(1);

    fireEvent.change(bagQty, { target: { value: '2' } });
    expect(screen.getByText('الإجمالي: علبة واحدة و كيسان (12 كيساً)')).toBeInTheDocument();
  });

  it('converts a 30-day period to 1 month when the unit changes', () => {
    const med = makeMed({
      currentPills: 1,
      dailyDose: 1,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
    });
    renderView({ medications: [med] });

    const periodLabel = screen.getByText('مدة الطلب');
    const periodContainer = periodLabel.parentElement!;
    const periodInput = periodContainer.querySelector('input[type="number"]') as HTMLInputElement;
    const periodSelect = periodContainer.querySelector('select') as HTMLSelectElement;

    expect(periodInput.value).toBe('30');
    fireEvent.change(periodSelect, { target: { value: 'month' } });
    expect(periodInput.value).toBe('1');

    fireEvent.change(periodSelect, { target: { value: 'day' } });
    expect(periodInput.value).toBe('30');
  });

  it('clicking WhatsApp send button opens the send modal with analyzed order quantities', () => {
    const medA = makeMed({ id: 'med-a', name: 'كونكور 5', currentPills: 2, dailyDose: 1, stripsPerBox: 3, pillsPerStrip: 10 });
    renderView({ medications: [medA] });

    const sendBtn = screen.getByRole('button', { name: 'إرسال طلبية بالواتساب' });
    fireEvent.click(sendBtn);

    // Modal opens
    expect(screen.getByText('إرسال الطلب للصيدلية')).toBeInTheDocument();
    expect(screen.getByText(/فتح محادثة واتساب الآن/)).toBeInTheDocument();
    expect(screen.getAllByText('كونكور 5').length).toBeGreaterThanOrEqual(2);
  });

  it('includes only checked saved user contact details in the WhatsApp message', () => {
    const med = makeMed({ id: 'med-contact', name: 'Contact Med', currentPills: 1, dailyDose: 1 });
    renderView({
      medications: [med],
      settings: {
        ...defaultSettings,
        whatsappContacts: [
          { id: 'phone-home', label: 'البيت', phone: '01000000000' },
          { id: 'phone-work', label: 'العمل', phone: '01111111111' },
        ],
        whatsappAddresses: [
          { id: 'address-home', label: 'البيت', address: 'شارع 10' },
        ],
        selectedWhatsappContactIds: ['phone-home'],
        selectedWhatsappAddressIds: ['address-home'],
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'إرسال طلبية بالواتساب' }));

    // Contact phone line shows ONLY the number — the descriptive label
    // (e.g. "البيت") must NOT be included in the WhatsApp message.
    expect(screen.getByText(/رقم التواصل: 01000000000/)).toBeInTheDocument();
    expect(screen.queryByText(/البيت: 01000000000/)).toBeNull();
    // Address line also shows ONLY the address — the descriptive label
    // must NOT be included.
    expect(screen.getByText(/العنوان: شارع 10/)).toBeInTheDocument();
    expect(screen.queryByText(/البيت: شارع 10/)).toBeNull();
    // Unselected contact phone must not appear in the message.
    // (The bare number still shows in the contact list UI — only check
    //  it isn't present as a "رقم التواصل:" line in the message.)
    expect(screen.queryByText(/رقم التواصل: 01111111111/)).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'إضافة العمل إلى الرسالة' })).not.toBeChecked();
  });

});


describe('PharmacyShoppingView — medication-level stock projection', () => {
  it('Medication ON with past lastSync appears as urgent under auto projection', () => {
    const med = makeMed({
      id: 'urgent-candidate',
      name: 'Projected Med',
      currentPills: 30,
      dailyDose: 2,
      autoDeductEnabled: true,
      warningThresholdDays: 5,
    });
    render(
      <PharmacyShoppingView
        medications={[med]}
        settings={defaultSettings}
        onUpdateSettings={() => {}}
        showToast={() => {}}
      />
    );
    expect(screen.getByText('Projected Med')).toBeInTheDocument();
  });

  it('Medication OFF with past lastSync is not urgent (frozen sufficient stock)', () => {
    const med = makeMed({
      id: 'frozen',
      name: 'Frozen Med',
      currentPills: 30,
      dailyDose: 2,
      autoDeductEnabled: false,
      warningThresholdDays: 5,
    });
    render(
      <PharmacyShoppingView
        medications={[med]}
        settings={defaultSettings}
        onUpdateSettings={() => {}}
        showToast={() => {}}
      />
    );
    expect(screen.queryByText('Frozen Med')).not.toBeInTheDocument();
  });
});


describe('PharmacyShoppingView — period and custom quantity allow empty mid-edit', () => {
  afterEach(() => cleanup());

  it('مدة الطلب value can be cleared then set to 2', () => {
    const med = makeMed({
      currentPills: 1,
      dailyDose: 1,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
    });
    renderView({ medications: [med] });
    // Period value is the number spinbutton near "مدة الطلب"
    const periodLabel = screen.getByText('مدة الطلب');
    const periodInput = periodLabel.parentElement!.querySelector('input[type="number"]') as HTMLInputElement;
    expect(periodInput).toBeTruthy();
    fireEvent.change(periodInput, { target: { value: '' } });
    expect(periodInput.value).toBe('');
    fireEvent.change(periodInput, { target: { value: '2' } });
    expect(periodInput.value).toBe('2');
  });

  it('كمية محددة can be cleared then set to 2 without snapping back to 1', () => {
    const med = makeMed({
      currentPills: 1,
      dailyDose: 1,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
    });
    renderView({ medications: [med] });
    fireEvent.click(screen.getByRole('button', { name: 'كمية محددة' }));
    const qty = screen.getByRole('spinbutton', { name: /كمية Test Med شريط/ }) as HTMLInputElement;
    fireEvent.change(qty, { target: { value: '' } });
    expect(qty.value).toBe('');
    fireEvent.change(qty, { target: { value: '2' } });
    expect(qty.value).toBe('2');
    expect(screen.getByText(/الإجمالي:/)).toBeInTheDocument();
  });
});
