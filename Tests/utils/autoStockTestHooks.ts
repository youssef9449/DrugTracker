import type { AutoStockDurableState } from '../../src/utils/autoDeductionStockGate';
import type {
  ExactAutoEnvelopeStored,
  ManualStockEnvelope,
} from '../../src/utils/stockEnvelopeRecovery';

type OrderingHooks = {
  loadLastApplied?: () => number;
  persistLastApplied?: (seq: number) => string | null;
  allocate?: () => { ok: true; seq: number } | { ok: false; error: string };
};

type GateHooks = {
  load?: () => AutoStockDurableState;
  commit?: (state: AutoStockDurableState) => string | null;
  loadGeneration?: () => number;
  bumpGeneration?: () => string | null;
  persistGlobal?: (value: boolean) => string | null;
};

type EnvelopeHooks<T> = {
  load?: () => T | null;
  save?: (env: T | null) => string | null;
};

let ordering: OrderingHooks | null = null;
let gate: GateHooks | null = null;
let manualEnvelope: EnvelopeHooks<ManualStockEnvelope> | null = null;
let exactStorageEnvelope: EnvelopeHooks<ExactAutoEnvelopeStored> | null = null;
let exactReconciliationEnvelope: EnvelopeHooks<{
  version: 1;
  status: 'js_ready';
  medications: unknown[];
  logs: unknown[];
  globalAutoDeductEnabled: boolean;
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  createdAt: string;
  mutationSeq: number;
}> | null = null;

let originalStorage: Storage | null = null;
let installed = false;
let gateCommitObserved = false;

const MEDS_KEY = 'android_med_tracker_items_v2';
const LOGS_KEY = 'android_med_tracker_logs_v2';
const GLOBAL_KEY = 'android_med_tracker_auto_deduct_v1';
const STOCK_GEN_KEY = 'android_med_tracker_stock_generation_v1';
const LAST_APPLIED_KEY = 'android_med_tracker_stock_mutation_seq_applied_v1';
const NEXT_SEQ_KEY = 'android_med_tracker_stock_mutation_seq_next_v1';
const MANUAL_ENV_KEY = 'android_med_tracker_manual_stock_envelope_v1';
const EXACT_ENV_KEY = 'android_med_tracker_exact_auto_envelope_v1';

function ensureInstalled(): void {
  if (installed || typeof localStorage === 'undefined') return;
  originalStorage = localStorage;
  const real = originalStorage;

  const adapter = {
    get length() {
      return real.length;
    },
    key(index: number) {
      return real.key(index);
    },
    getItem(key: string) {
      if (key === MEDS_KEY && gate?.load) {
        return JSON.stringify(gate.load().medications);
      }
      if (key === LOGS_KEY && gate?.load) {
        return JSON.stringify(gate.load().logs);
      }
      if (key === GLOBAL_KEY && gate?.load) {
        const value = gate.load().globalAutoDeductEnabled;
        return value == null ? null : String(value);
      }
      if (key === STOCK_GEN_KEY && gate?.loadGeneration) {
        return String(gate.loadGeneration());
      }
      if (key === LAST_APPLIED_KEY && ordering?.loadLastApplied) {
        return String(ordering.loadLastApplied());
      }
      if (key === MANUAL_ENV_KEY && manualEnvelope?.load) {
        const value = manualEnvelope.load();
        return value == null ? null : JSON.stringify(value);
      }
      if (key === EXACT_ENV_KEY) {
        if (exactReconciliationEnvelope?.load) {
          const value = exactReconciliationEnvelope.load();
          return value == null ? null : JSON.stringify(value);
        }
        if (exactStorageEnvelope?.load) {
          const value = exactStorageEnvelope.load();
          return value == null ? null : JSON.stringify(value);
        }
      }
      return real.getItem(key);
    },
    setItem(key: string, value: string) {
      if (key === NEXT_SEQ_KEY && ordering?.allocate) {
        const result = ordering.allocate();
        if (!result.ok) throw new Error(result.error);
        return;
      }

      if (key === LAST_APPLIED_KEY && ordering?.persistLastApplied) {
        const error = ordering.persistLastApplied(Number(value));
        if (error) throw new Error(error);
        return;
      }

      if (key === STOCK_GEN_KEY && gate?.bumpGeneration) {
        const error = gate.bumpGeneration();
        if (error) throw new Error(error);
        return;
      }

      if (key === GLOBAL_KEY && gate?.persistGlobal) {
        const error = gate.persistGlobal(value !== 'false');
        if (error) throw new Error(error);
        return;
      }

      if (key === MANUAL_ENV_KEY && manualEnvelope?.save) {
        const env = JSON.parse(value) as ManualStockEnvelope;
        const error = manualEnvelope.save(env);
        if (error) throw new Error(error);
        return;
      }

      if (key === EXACT_ENV_KEY) {
        const hook = exactReconciliationEnvelope?.save ?? exactStorageEnvelope?.save;
        if (hook) {
          const env = JSON.parse(value) as never;
          const error = hook(env);
          if (error) throw new Error(error);
          return;
        }
      }

      if ((key === MEDS_KEY || key === LOGS_KEY) && gate?.commit) {
        if (gateCommitObserved) {
          if (key === LOGS_KEY) gateCommitObserved = false;
          return;
        }
        const loaded = gate.load
          ? gate.load()
          : {
              medications: JSON.parse(real.getItem(MEDS_KEY) ?? '[]'),
              logs: JSON.parse(real.getItem(LOGS_KEY) ?? '[]'),
              globalAutoDeductEnabled: real.getItem(GLOBAL_KEY) !== 'false',
            };
        const nextState: AutoStockDurableState = {
          medications:
            key === MEDS_KEY
              ? JSON.parse(value)
              : loaded.medications,
          logs:
            key === LOGS_KEY
              ? JSON.parse(value)
              : loaded.logs,
          globalAutoDeductEnabled: loaded.globalAutoDeductEnabled,
        };
        const error = gate.commit(nextState);
        gateCommitObserved = true;
        if (error) throw new Error(error);
        return;
      }

      gateCommitObserved = false;
      real.setItem(key, value);
    },
    removeItem(key: string) {
      if (key === MANUAL_ENV_KEY && manualEnvelope?.save) {
        const error = manualEnvelope.save(null);
        if (error) throw new Error(error);
        return;
      }
      if (key === EXACT_ENV_KEY) {
        const hook = exactReconciliationEnvelope?.save ?? exactStorageEnvelope?.save;
        if (hook) {
          const error = hook(null);
          if (error) throw new Error(error);
          return;
        }
      }
      real.removeItem(key);
    },
    clear() {
      real.clear();
    },
  } as Storage;

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: adapter,
  });
  installed = true;
}

function maybeRestore(): void {
  if (
    installed &&
    !ordering &&
    !gate &&
    !manualEnvelope &&
    !exactStorageEnvelope &&
    !exactReconciliationEnvelope &&
    originalStorage
  ) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalStorage,
    });
    originalStorage = null;
    installed = false;
    gateCommitObserved = false;
  }
}

export function __setStockMutationOrderingTestHooks(hooks: OrderingHooks | null): void {
  ordering = hooks;
  ensureInstalled();
}

export function __resetStockMutationOrderingForTests(): void {
  ordering = null;
  maybeRestore();
}

export function __setAutoStockGateTestHooks(hooks: GateHooks | null): void {
  gate = hooks;
  gateCommitObserved = false;
  ensureInstalled();
}

export function __setManualEnvelopeTestHooks(
  hooks: EnvelopeHooks<ManualStockEnvelope> | null
): void {
  manualEnvelope = hooks;
  ensureInstalled();
}

export function __setExactAutoEnvelopeStorageTestHooks(
  hooks: EnvelopeHooks<ExactAutoEnvelopeStored> | null
): void {
  exactStorageEnvelope = hooks;
  ensureInstalled();
}

export function __setExactAutoEnvelopeTestHooks(
  hooks: EnvelopeHooks<{
    version: 1;
    status: 'js_ready';
    medications: unknown[];
    logs: unknown[];
    globalAutoDeductEnabled: boolean;
    toAcknowledge: Array<{
      medicationId: string;
      doseId: string;
      calendarDate: string;
    }>;
    createdAt: string;
    mutationSeq: number;
  }> | null
): void {
  exactReconciliationEnvelope = hooks;
  ensureInstalled();
}

export function resetAutoStockTestHooks(): void {
  ordering = null;
  gate = null;
  manualEnvelope = null;
  exactStorageEnvelope = null;
  exactReconciliationEnvelope = null;
  maybeRestore();
}
