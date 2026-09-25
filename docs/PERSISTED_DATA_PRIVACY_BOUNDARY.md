# Persisted Data Privacy Boundary

## Scope

Drug Tracker stores application state in browser `localStorage` for the Web/PWA surface and for the React WebView used by the native Android build.

Persisted data includes:

- medication names, dosage schedules, dose instructions, treatment dates, stock quantities, and notes;
- medication consumption/skipped history and refill/reversal logs;
- pharmacy names, phone numbers, contact selections, and addresses;
- notification, reminder, Auto-Deduction, and other application preferences.

## Threat model

`localStorage` is an application-origin data store, not a confidentiality boundary.

Any JavaScript executing in the same trusted origin can read the persisted values. This means:

- an XSS or compromised same-origin script can access all persisted application data;
- localStorage must not be used for passwords, authentication tokens, encryption keys, or other secrets;
- moving the same plaintext data to another JavaScript-accessible Web API does not materially improve protection against a compromised application origin.

The native Android WebView runs inside the application's OS sandbox, which protects its files from unrelated applications, but that sandbox does not stop JavaScript running inside the application's own origin from reading localStorage.

## Data classification

| Data class | Sensitivity | Current store | Confidentiality guarantee |
| --- | --- | --- | --- |
| Medication names, doses, treatment dates, notes | Health-related sensitive data | localStorage | No same-origin script confidentiality |
| Current stock and consumption history | Health-related sensitive data | localStorage | No same-origin script confidentiality |
| Pharmacy/contact/address data | Personal data | localStorage | No same-origin script confidentiality |
| Reminder/notification preferences | Personal/application data | localStorage | No same-origin script confidentiality |
| Credentials, auth tokens, encryption keys | Secret material | Not used by the app | Must never be persisted in localStorage |

## Design decision

For the current Web/PWA architecture, medication and related personal data remain in localStorage because the application itself must read and mutate this state in the same origin. This issue does **not** introduce homemade encryption: encryption with a key stored in the same origin would not establish a meaningful confidentiality boundary.

The current product therefore makes an explicit architectural distinction:

1. localStorage is acceptable for application state persistence but is **not** claimed to be confidential storage;
2. no secret material may be added to localStorage;
3. native secure storage is required if a future feature introduces credentials, long-lived secrets, or a requirement to protect persisted health/personal data from storage-level access outside the WebView;
4. such a future native-secure-storage design must keep key material in a platform key store (for example Android Keystore) and expose only the minimum required capability to JavaScript.

This PR intentionally documents the boundary and decision. It does not add a fake encryption layer or create a second persistence system.

## Hardening strategy (current state and next steps)

Concrete hardening measures in the current architecture:

1. **No secret material in localStorage (verified).** The persisted-state
   surface contains medication/log/pharmacy/preference data only; no
   credentials, tokens, or keys are stored. Any future feature introducing
   secret material MUST use platform-backed storage per the decision above.
2. **Bounded retention for health-related history.** Per-dose consumption/skip
   history and the consumption log are pruned deterministically at durable
   write boundaries (`pruneDoseConsumption.ts`, 400-day windows), so the
   plaintext exposure surface grows with active use, not unboundedly.
3. **Runtime-validated reads.** Persisted data is validated at the storage
   boundary (`readJsonOutcome`/`loadValidatedJson` in `storage.ts`); corrupt
   or foreign-shaped payloads are reported explicitly instead of silently
   reinterpreted, which limits what a corrupted store can do unnoticed.
4. **Native retry payload minimization.** The Android notification runtime
   persists only the minimum fields needed to reconstruct a failed delivery
   and no longer stores redundant presentation metadata (see
   `NotificationRuntime.persistRetry` privacy boundary note).

**Content-Security-Policy defense in depth:** a restrictive CSP
(`default-src 'self'`, no `unsafe-inline` scripts, explicit connect-src
allowlist) is RECOMMENDED as the next mitigation layer against same-origin
script injection reading these stores. CSP for this app is delivered by the
document/headers of the hosting surface (index.html / server config), which
is a deployment-layer change outside this runtime batch; the recommendation
is recorded here so the follow-up has a defined home.

**OS-backed/encrypted native storage (evaluation):** for data requiring
confidentiality beyond the WebView origin — e.g. if medication data must be
protected against device-local storage extraction — the evaluated design is
Android EncryptedSharedPreferences / Keystore-backed storage exposed through
a small Capacitor plugin, with JS keeping only non-sensitive mirrors. This is
a deliberate architecture change (native becomes the confidentiality
authority) and is NOT part of the current storage model; it remains the
documented upgrade path rather than a parallel system introduced today.

