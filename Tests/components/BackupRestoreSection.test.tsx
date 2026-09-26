/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { BackupRestoreSection } from '../../src/components/settings/BackupRestoreSection';
import { RestoreBackupModal } from '../../src/components/settings/RestoreBackupModal';
import type { Medication, PharmacySettings, ConsumptionLog } from '../../src/types';
import type { ParsedBackupData } from '../../src/utils/backupRestore';

const mockMeds: Medication[] = [
  {
    id: 'med-1',
    name: 'Panadol Extra',
    currentPills: 20,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
  },
];

const mockLogs: ConsumptionLog[] = [
  {
    id: 'log-1',
    medicationId: 'med-1',
    medicationName: 'Panadol Extra',
    type: 'dose_taken',
    amount: -1,
    date: '2026-09-26',
    timestamp: '2026-09-26T08:05:00.000Z',
    description: 'تناول جرعة الصباح',
  },
];

const mockPharmacySettings: PharmacySettings = {
  defaultDurationDays: 30,
  pharmacies: [
    {
      id: 'pharm-1',
      name: 'صيدلية الأمل',
      phone: '01001234567',
      customerCode: 'CUST-100',
    },
  ],
  selectedPharmacyId: 'pharm-1',
  whatsappContacts: [{ id: 'c-1', label: 'رقمي الشخصي', phone: '01011112222' }],
  whatsappAddresses: [{ id: 'a-1', label: 'المنزل', address: 'شارع التحرير' }],
  selectedWhatsappContactIds: ['c-1'],
  selectedWhatsappAddressIds: ['a-1'],
};

describe('BackupRestoreSection Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('renders backup and restore controls with scope options', () => {
    render(
      <BackupRestoreSection
        medications={mockMeds}
        logs={mockLogs}
        pharmacySettings={mockPharmacySettings}
        onRestore={vi.fn()}
        soundEnabled={true}
      />
    );

    expect(screen.getByText('النسخ الاحتياطي والاستعادة')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /الأدوية فقط/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /حفظ نسخة \(كل البيانات\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /استعادة من ملف/ })).toBeInTheDocument();
  });

  it('switches between "الأدوية فقط" and "كل البيانات"', () => {
    render(
      <BackupRestoreSection
        medications={mockMeds}
        logs={mockLogs}
        pharmacySettings={mockPharmacySettings}
        onRestore={vi.fn()}
        soundEnabled={true}
      />
    );

    // Default is all data
    expect(screen.getByText(/حفظ نسخة \(كل البيانات\)/)).toBeInTheDocument();

    // Click medications only
    const medsOnlyBtn = screen.getByRole('button', { name: /الأدوية فقط/ });
    fireEvent.click(medsOnlyBtn);

    expect(screen.getByText(/حفظ نسخة \(الأدوية\)/)).toBeInTheDocument();
  });

  it('handles restore confirmation and checkbox toggles including medications in RestoreBackupModal', async () => {
    const onConfirmRestore = vi.fn();
    const onClose = vi.fn();

    const backupData: ParsedBackupData = {
      scope: 'all',
      exportedAt: '2026-09-26T12:00:00.000Z',
      medications: [
        {
          id: 'med-backup-1',
          name: 'Omega 3 Fish Oil',
          currentPills: 30,
          dailyDose: 1,
          unit: 'كبسولة',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      logs: mockLogs,
      pharmacySettings: mockPharmacySettings,
      rawCount: 1,
      validCount: 1,
    };

    render(
      <RestoreBackupModal
        isOpen={true}
        onClose={onClose}
        backupData={backupData}
        currentMedicationsCount={1}
        onConfirmRestore={onConfirmRestore}
      />
    );

    expect(screen.getByText('استعادة النسخة الاحتياطية')).toBeInTheDocument();
    expect(screen.getByText('Omega 3 Fish Oil')).toBeInTheDocument();
    expect(screen.getAllByText(/صيدلية/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/أرقام هاتف/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/عناوين/).length).toBeGreaterThan(0);

    // Verify all 3 checkboxes exist with proper accessible labels
    const medsCheckbox = screen.getByRole('checkbox', {
      name: 'استعادة الأدوية والمواعيد',
    }) as HTMLInputElement;
    const logsCheckbox = screen.getByRole('checkbox', {
      name: 'استعادة سجلات الاستهلاك السابقة',
    }) as HTMLInputElement;
    const pharmacyCheckbox = screen.getByRole('checkbox', {
      name: 'استعادة بيانات الصيدليات وأرقام الهاتف والعناوين',
    }) as HTMLInputElement;

    expect(medsCheckbox.checked).toBe(true);
    expect(logsCheckbox.checked).toBe(true);
    expect(pharmacyCheckbox.checked).toBe(true);

    // Toggle medications off
    fireEvent.click(medsCheckbox);
    expect(medsCheckbox.checked).toBe(false);

    // Medications preview should hide when unselected
    expect(screen.queryByText(/معاينة الأدوية التي ستستعاد/)).not.toBeInTheDocument();

    // Toggle logs off
    fireEvent.click(logsCheckbox);
    expect(logsCheckbox.checked).toBe(false);

    // Confirm restore (only pharmacy settings remain selected)
    const confirmBtn = screen.getByRole('button', { name: 'تأكيد استعادة البيانات' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(onConfirmRestore).toHaveBeenCalledWith(
        expect.objectContaining({
          backupMedications: [], // unselected
          backupLogs: undefined, // unselected
          mode: 'replace',
          restorePharmacySettings: true,
        })
      );
    });
  });
});
