/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication, PharmacySettings } from '@/types';
import { usePharmacyShoppingModel } from '@/hooks/usePharmacyShoppingModel';
import * as whatsapp from '@/utils/whatsapp';

vi.mock('@/utils/whatsapp', async () => {
  const actual = await vi.importActual<typeof import('@/utils/whatsapp')>('@/utils/whatsapp');
  return {
    ...actual,
    generatePharmacyOrderMessage: vi.fn(actual.generatePharmacyOrderMessage),
  };
});

const generateSpy = vi.mocked(whatsapp.generatePharmacyOrderMessage);

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Aspirin',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    packageSize: 30,
    doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    ...overrides,
  };
}

const baseSettings: PharmacySettings = {
  defaultDurationDays: 30,
  pharmacies: [
    {
      id: 'ph-1',
      name: 'Test Pharmacy',
      phone: '01000000000',
      customerCode: 'C-1',
    },
  ],
  selectedPharmacyId: 'ph-1',
  whatsappContacts: [],
  whatsappAddresses: [],
  selectedWhatsappContactIds: [],
  selectedWhatsappAddressIds: [],
};

describe('usePharmacyShoppingModel — order message memoization (#550)', () => {
  beforeEach(() => {
    generateSpy.mockClear();
  });

  it('does not recompute WhatsApp message on unrelated parent rerender when shopping inputs are stable', () => {
    const medications = [makeMed()];
    const settings = { ...baseSettings };
    let tick = 0;

    const { result, rerender } = renderHook(
      ({ meds, prefs, noise }) => {
        // noise is intentionally unused by the shopping model — simulates
        // an unrelated parent state change that forces a rerender.
        void noise;
        return usePharmacyShoppingModel({
          medications: meds,
          settings: prefs,
          onUpdateSettings: vi.fn(),
          showToast: vi.fn(),
        });
      },
      {
        initialProps: { meds: medications, prefs: settings, noise: tick },
      }
    );

    // Access derived message so memoized chain is evaluated.
    const firstMessage = result.current.currentWhatsAppMessage;
    expect(firstMessage).toBeTruthy();
    const callsAfterFirst = generateSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Unrelated parent rerender: same meds/settings identity, different noise.
    tick += 1;
    rerender({ meds: medications, prefs: settings, noise: tick });

    expect(result.current.currentWhatsAppMessage).toBe(firstMessage);
    expect(generateSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('recomputes WhatsApp message when a genuine shopping input changes', () => {
    const medications = [makeMed()];
    let settings = { ...baseSettings };

    const { result, rerender } = renderHook(
      ({ meds, prefs }) =>
        usePharmacyShoppingModel({
          medications: meds,
          settings: prefs,
          onUpdateSettings: vi.fn(),
          showToast: vi.fn(),
        }),
      {
        initialProps: { meds: medications, prefs: settings },
      }
    );

    const firstMessage = result.current.currentWhatsAppMessage;
    const callsAfterFirst = generateSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Genuine dependency: default duration affects order quantities / message.
    settings = { ...settings, defaultDurationDays: 14 };
    rerender({ meds: medications, prefs: settings });

    expect(generateSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    // Message content may or may not differ depending on selection, but
    // the pure generator must have been invoked again for the new inputs.
    expect(result.current.currentWhatsAppMessage).toBeDefined();
    void firstMessage;
  });
});
