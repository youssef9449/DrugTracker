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

    expect(screen.getByText(/حفظ نسخة \(كل البيانات\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /الأدوية فقط/ }));
    expect(screen.getByText(/حفظ نسخة \(الأدوية\)/)).toBeInTheDocument();
  });

  it('requires at least one applicable restore selection', () => {
    render(
      <RestoreBackupModal
        isOpen={true}
        onClose={vi.fn()}
        backupData={backupData}
        currentMedicationsCount={1}
        onConfirmRestore={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'استعادة الأدوية والمواعيد' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'استعادة سجلات الاستهلاك السابقة' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'استعادة بيانات الصيدليات وأرقام الهاتف والعناوين' }));

    expect(screen.getByRole('button', { name: 'تأكيد استعادة البيانات' })).toBeDisabled();
  });

  it('allows logs independently in merge mode and maps the selected restore payload', async () => {
    const onConfirmRestore = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();

    render(
      <RestoreBackupModal
        isOpen={true}
        onClose={onClose}
        backupData={backupData}
        currentMedicationsCount={1}
        onConfirmRestore={onConfirmRestore}
      />
    );

    const medsCheckbox = screen.getByRole('checkbox', {
      name: 'استعادة الأدوية والمواعيد',
    }) as HTMLInputElement;
    const logsCheckbox = screen.getByRole('checkbox', {
      name: 'استعادة سجلات الاستهلاك السابقة',
    }) as HTMLInputElement;

    fireEvent.click(screen.getByText('دمج مع البيانات الحالية'));
    fireEvent.click(medsCheckbox);
    expect(medsCheckbox.checked).toBe(false);
    expect(logsCheckbox.disabled).toBe(false);
    expect(logsCheckbox.checked).toBe(true);

    const pharmacyCheckbox = screen.getByRole('checkbox', {
      name: 'استعادة بيانات الصيدليات وأرقام الهاتف والعناوين',
    }) as HTMLInputElement;
    fireEvent.click(pharmacyCheckbox);

    const confirmBtn = screen.getByRole('button', { name: 'تأكيد استعادة البيانات' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(onConfirmRestore).toHaveBeenCalledWith(
        expect.objectContaining({
          backupMedications: [],
          backupLogs: mockLogs,
          restoreLogs: true,
          mode: 'merge',
          restorePharmacySettings: false,
        })
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('supports pharmacy-only restore without restoring medications or logs', async () => {
    const onConfirmRestore = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();

    render(
      <RestoreBackupModal
        isOpen={true}
        onClose={onClose}
        backupData={backupData}
        currentMedicationsCount={3}
        onConfirmRestore={onConfirmRestore}
      />
    );

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'استعادة الأدوية والمواعيد',
      })
    );
    expect(
      screen.getByRole('checkbox', {
        name: 'استعادة سجلات الاستهلاك السابقة',
      })
    ).toBeDisabled();

    const confirmBtn = screen.getByRole('button', {
      name: 'تأكيد استعادة البيانات',
    });
    expect(confirmBtn).toBeEnabled();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(onConfirmRestore).toHaveBeenCalledWith(
        expect.objectContaining({
          backupMedications: [],
          backupLogs: undefined,
          restoreLogs: false,
          mode: 'replace',
          pharmacySettings: mockPharmacySettings,
          restorePharmacySettings: true,
        })
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the modal open when restore fails', async () => {
    const onConfirmRestore = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();

    render(
      <RestoreBackupModal
        isOpen={true}
        onClose={onClose}
        backupData={backupData}
        currentMedicationsCount={0}
        onConfirmRestore={onConfirmRestore}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد استعادة البيانات' }));

    await waitFor(() => {
      expect(onConfirmRestore).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
