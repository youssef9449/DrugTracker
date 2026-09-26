import { describe, it, expect } from 'vitest';
import {
  createBackupPayload,
  parseAndValidateBackupFile,
  normalizeMedicationForImport,
  normalizePharmacySettingsForImport,
} from '../../src/utils/backupRestore';
import type { Medication, ConsumptionLog, PharmacySettings } from '../../src/types';

const mockMeds: Medication[] = [
  {
    id: 'med-1',
    name: 'Panadol Extra',
    currentPills: 24,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 4,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    reminderEnabled: true,
    reminderTime: '08:00',
    category: 'مسكنات',
    notes: 'بعد الأكل',
    doseSchedule: [
      { id: 'dose-1', amount: 1, time: '08:00', description: 'الصباح' },
      { id: 'dose-2', amount: 1, time: '20:00', description: 'المساء' },
    ],
  },
  {
    id: 'med-2',
    name: 'Amoxicillin',
    currentPills: 14,
    dailyDose: 1,
    unit: 'كبسولة',
    warningThresholdDays: 3,
    colorTag: 'blue',
    createdAt: '2026-02-01T00:00:00.000Z',
    autoDeductEnabled: false,
    doseSchedule: [{ id: 'dose-3', amount: 1, time: '14:00' }],
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
  whatsappContacts: [{ id: 'c-1', label: 'رقمي', phone: '01011112222' }],
  whatsappAddresses: [{ id: 'a-1', label: 'المنزل', address: 'شارع التحرير' }],
  selectedWhatsappContactIds: ['c-1'],
  selectedWhatsappAddressIds: ['a-1'],
};

describe('backupRestore utility', () => {
  it('creates complete backup envelope for "all" data', () => {
    const backup = createBackupPayload('all', mockMeds, mockLogs, mockPharmacySettings);

    expect(backup.version).toBe(1);
    expect(backup.app).toBe('drug-tracker');
    expect(backup.scope).toBe('all');
    expect(backup.metadata.medicationsCount).toBe(2);
    expect(backup.metadata.logsCount).toBe(1);
    expect(backup.metadata.pharmaciesCount).toBe(1);
    expect(backup.metadata.contactsCount).toBe(1);
    expect(backup.metadata.addressesCount).toBe(1);
    expect(backup.medications).toEqual(mockMeds);
    expect(backup.logs).toEqual(mockLogs);
    expect(backup.pharmacySettings).toEqual(mockPharmacySettings);
    expect(typeof backup.exportedAt).toBe('string');
  });

  it('creates medication-only backup when scope is "medications"', () => {
    const backup = createBackupPayload('medications', mockMeds, mockLogs, mockPharmacySettings);

    expect(backup.version).toBe(1);
    expect(backup.scope).toBe('medications');
    expect(backup.metadata.medicationsCount).toBe(2);
    expect(backup.metadata.logsCount).toBe(0);
    expect(backup.metadata.pharmaciesCount).toBe(0);
    expect(backup.medications).toEqual(mockMeds);
    expect(backup.logs).toBeUndefined();
    expect(backup.pharmacySettings).toBeUndefined();
  });

  it('validates and parses valid envelope JSON successfully', () => {
    const backup = createBackupPayload('all', mockMeds, mockLogs, mockPharmacySettings);
    const jsonStr = JSON.stringify(backup);

    const result = parseAndValidateBackupFile(jsonStr);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.medications.length).toBe(2);
    expect(result.data.medications[0]?.name).toBe('Panadol Extra');
    expect(result.data.logs.length).toBe(1);
    expect(result.data.pharmacySettings?.pharmacies.length).toBe(1);
    expect(result.data.pharmacySettings?.whatsappContacts.length).toBe(1);
    expect(result.data.pharmacySettings?.whatsappAddresses.length).toBe(1);
  });

  it('validates and parses a raw array of medications successfully', () => {
    const jsonStr = JSON.stringify(mockMeds);

    const result = parseAndValidateBackupFile(jsonStr);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.medications.length).toBe(2);
    expect(result.data.validCount).toBe(2);
  });

  it('fails gracefully on empty or whitespace strings', () => {
    expect(parseAndValidateBackupFile('').ok).toBe(false);
    expect(parseAndValidateBackupFile('   ').ok).toBe(false);
  });

  it('fails gracefully on corrupted JSON syntax', () => {
    const result = parseAndValidateBackupFile('{"invalid": json syntax here');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('JSON');
  });

  it('fails gracefully on foreign application payloads', () => {
    const foreign = JSON.stringify({
      app: 'some-other-unrelated-app',
      medications: [{ name: 'Test' }],
    });
    const result = parseAndValidateBackupFile(foreign);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('غير مخصص');
  });

  it('fails gracefully when JSON has no medications', () => {
    const result = parseAndValidateBackupFile('{"version": 1, "medications": []}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('لم يتم العثور على أدوية');
  });

  it('normalizes partial medications with safe defaults', () => {
    const partial = {
      name: 'Aspirin',
      currentPills: 10,
      dailyDose: 1,
    };

    const normalized = normalizeMedicationForImport(partial);
    expect(normalized).not.toBeNull();
    if (!normalized) return;

    expect(normalized.name).toBe('Aspirin');
    expect(normalized.id).toBeDefined();
    expect(normalized.unit).toBe('قرص');
    expect(normalized.warningThresholdDays).toBe(5);
    expect(normalized.colorTag).toBe('teal');
    expect(normalized.doseSchedule).toBeDefined();
    expect(normalized.doseSchedule?.length).toBe(1);
    expect(normalized.doseSchedule?.[0]?.amount).toBe(1);
  });

  it('rejects entries with missing or empty medication name', () => {
    expect(normalizeMedicationForImport({})).toBeNull();
    expect(normalizeMedicationForImport({ name: '' })).toBeNull();
    expect(normalizeMedicationForImport({ name: '   ' })).toBeNull();
  });

  it('sanitizes and normalizes pharmacy settings cleanly without crashing', () => {
    const rawSettings = {
      defaultDurationDays: 60,
      pharmacies: [
        { id: 'p1', name: ' صيدلية الشفاء ', phone: ' 012345 ', extraProp: 123 },
        { id: 'p2', name: '' }, // invalid empty name
        null,
      ],
      whatsappContacts: [
        { id: 'c1', label: ' أبي ', phone: '01111' },
        { id: 'c2', label: '   ' }, // invalid empty label
      ],
      whatsappAddresses: [
        { id: 'a1', label: ' العمل ', address: ' المعادي ' },
      ],
      selectedPharmacyId: 'p1',
      selectedWhatsappContactIds: ['c1', 999], // non-string will be filtered
    };

    const normalized = normalizePharmacySettingsForImport(rawSettings);
    expect(normalized).toBeDefined();
    if (!normalized) return;

    expect(normalized.defaultDurationDays).toBe(60);
    expect(normalized.pharmacies.length).toBe(1);
    expect(normalized.pharmacies[0]?.name).toBe('صيدلية الشفاء');
    expect(normalized.whatsappContacts.length).toBe(1);
    expect(normalized.whatsappContacts[0]?.label).toBe('أبي');
    expect(normalized.whatsappAddresses.length).toBe(1);
    expect(normalized.whatsappAddresses[0]?.label).toBe('العمل');
    expect(normalized.selectedWhatsappContactIds).toEqual(['c1']);
  });
});
