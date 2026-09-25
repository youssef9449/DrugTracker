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
/**
 * Pending meds/logs writes of the CURRENT commitDurableAutoStockState
 * sequence (meds → logs → global → lastApplied → generation).
 *
 * The durable commit hook represents ONE atomic meds+logs commit, so the
 * adapter buffers the pair's writes and flushes exactly one gate.commit()
 * call once the sequence's global-switch write arrives (production always
 * writes it: every caller persists a non-null globalAutoDeductEnabled).
 * This models production localStorage faithfully: both the medications AND
 * the logs written by the same commit land in the hook-observed durable
 * state, together with the same commit's global master switch value.
 */
let pendingGateMeds: string | null = null;
let pendingGateLogs: string | null = null;
/**
 * Global master-switch value carried by the pending mutation's stock envelope
 * (Manual / Exact Auto). Every commitWithManualEnvelope-driven durable commit
 * persists its envelope (which contains the SAME globalAutoDeductEnabled the
 * subsequent commitDurableAutoStockState write persists), so the adapter can
 * bind the buffered meds+logs pair to the mutation's own global value instead
 * of the stale pre-commit snapshot.
 */
let pendingGateGlobal: boolean | null = null;

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

  /**
   * Flush the buffered meds+logs pair of the current
   * commitDurableAutoStockState sequence as exactly ONE durable commit.
   * `globalOverride` carries the mutation's own global-switch value (from its
   * stock envelope, or the sequence's global write); without one, the
   * pre-commit durable snapshot value is used.
   */
  function flushGateCommit(globalOverride: boolean | null | undefined): void {
    if (!gate?.commit) return;
    if (pendingGateMeds == null && pendingGateLogs == null) return;
    const loaded = gate.load
      ? gate.load()
      : {
          medications: JSON.parse(real.getItem(MEDS_KEY) ?? '[]'),
          logs: JSON.parse(real.getItem(LOGS_KEY) ?? '[]'),
          globalAutoDeductEnabled: real.getItem(GLOBAL_KEY) !== 'false',
        };
    const nextState: AutoStockDurableState = {
      medications:
        pendingGateMeds != null
          ? JSON.parse(pendingGateMeds)
          : loaded.medications,
      logs: pendingGateLogs != null ? JSON.parse(pendingGateLogs) : loaded.logs,
      globalAutoDeductEnabled:
        globalOverride != null ? globalOverride : loaded.globalAutoDeductEnabled,
    };
    // Consume the buffers before committing so a failed commit cannot leave a
    // stale pair behind for an unrelated future flush.
    pendingGateMeds = null;
    pendingGateLogs = null;
    pendingGateGlobal = null;
    const error = gate.commit(nextState);
    if (error) throw new Error(error);
  }

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
      // Stock envelopes carry the mutation's own global master-switch value;
      // remember it so the durable commit of THIS mutation flushes with it.
      if (key === MANUAL_ENV_KEY || key === EXACT_ENV_KEY) {
        try {
          const parsed = JSON.parse(value) as { globalAutoDeductEnabled?: unknown } | null;
          if (
            parsed != null &&
            typeof parsed.globalAutoDeductEnabled === 'boolean'
          ) {
            pendingGateGlobal = parsed.globalAutoDeductEnabled;
          }
        } catch {
          // Malformed envelope JSON is handled by the normal save path.
        }
      }

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

      if (key === GLOBAL_KEY && gate?.commit) {
        // Defensive: a meds+logs pair should already have flushed on its logs
        // write below; if one is still pending, bind it to THIS write's value.
        flushGateCommit(value !== 'false');
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
        // Buffer the pair; the durable commit flushes as ONE gate.commit()
        // call on the logs write (meds always precede logs in
        // commitDurableAutoStockState), bound to the mutation's own global
        // value captured from its stock envelope.
        if (key === MEDS_KEY) {
          pendingGateMeds = value;
        } else {
          pendingGateLogs = value;
          flushGateCommit(pendingGateGlobal);
        }
        return;
      }

      real.setItem(key, value);
    },
    removeItem(key: string) {
      if (key === MANUAL_ENV_KEY && manualEnvelope?.save) {
        pendingGateGlobal = null;
        const error = manualEnvelope.save(null);
        if (error) throw new Error(error);
        return;
      }
      if (key === EXACT_ENV_KEY) {
        const hook = exactReconciliationEnvelope?.save ?? exactStorageEnvelope?.save;
        if (hook) {
          pendingGateGlobal = null;
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
    pendingGateMeds = null;
    pendingGateLogs = null;
    pendingGateGlobal = null;
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
  pendingGateMeds = null;
  pendingGateLogs = null;
  pendingGateGlobal = null;
  ensureInstalled();
}

export function __setManualEnvelopeTestHooks(
  hooks: EnvelopeHooks<ManualStockEnvelope> | null
): void {
  manualEnvelope = hooks;
  pendingGateGlobal = null;
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
