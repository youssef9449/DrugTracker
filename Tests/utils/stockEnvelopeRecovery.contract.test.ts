import { beforeEach, describe, expect, it } from 'vitest';
import { loadManualStockEnvelope } from '@/utils/stockEnvelopeRecovery';

describe('Manual Stock envelope current schema', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('rejects an envelope missing globalAutoDeductEnabled', () => {
    localStorage.setItem(
      'android_med_tracker_manual_stock_envelope_v1',
      JSON.stringify({
        version: 1,
        status: 'manual_js_ready',
        medications: [],
        logs: [],
        createdAt: '2026-09-23T00:00:00.000Z',
        baseGeneration: 1,
        mutationSeq: 1,
        stockDeltas: [],
        occurrenceResolutions: [],
      })
    );
    expect(loadManualStockEnvelope()).toBeNull();
  });

  it('rejects an envelope with a non-boolean globalAutoDeductEnabled', () => {
    localStorage.setItem(
      'android_med_tracker_manual_stock_envelope_v1',
      JSON.stringify({
        version: 1,
        status: 'manual_js_ready',
        medications: [],
        logs: [],
        globalAutoDeductEnabled: 'true',
        createdAt: '2026-09-23T00:00:00.000Z',
        baseGeneration: 1,
        mutationSeq: 1,
        stockDeltas: [],
        occurrenceResolutions: [],
      })
    );
    expect(loadManualStockEnvelope()).toBeNull();
  });
});
