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
