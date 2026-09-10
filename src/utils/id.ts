/**
 * Generate a unique identifier with the given prefix.
 *
 * Uses `crypto.randomUUID()` when available (modern browsers, Capacitor
 * WebView, Node ≥ 19) for cryptographic uniqueness. Falls back to
 * `prefix + timestamp + random` for the rare environment without
 * `crypto.randomUUID` (older WebViews).
 *
 * This is the single source of truth for log/record ID generation across
 * the app — replacing the 3+ ad-hoc `prefix + Date.now() + Math.random()`
 * patterns that were copy-pasted across dateCalculations.ts and App.tsx
 * (audit issues #64 / #71).
 *
 * @param prefix Short semantic prefix (e.g. 'log', 'refill', 'consume',
 *   'restore', 'refill-undo'). A hyphen separator is inserted automatically.
 *
 * @example
 *   generateId('log')      // 'log-550e8400-e29b-41d4-a716-446655440000'
 *   generateId('refill')   // 'refill-6ba7b810-9dad-11d1-80b4-00c04fd430c8'
 */
export function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  // Fallback for environments without crypto.randomUUID (very rare in
  // practice — Capacitor WebView 58+ and all evergreen browsers have it).
  // Sufficient entropy: Date.now() (ms) + 8 chars base36 (~2.8T states).
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
