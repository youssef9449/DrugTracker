/**
 * IndexedDB-backed store for the user-uploaded global custom sound.
 *
 * WHY IndexedDB (not localStorage)
 * ---------------------------------
 * Custom sound files are read into a base64 data URL and can be up to
 * 2 MB each. The localStorage quota is ~5 MB on most browsers and is
 * shared with the rest of the app's persisted state (medications,
 * logs, pharmacy settings). Storing a couple of multi-megabyte audio
 * blobs in localStorage quickly exhausts the quota, and once
 * `setItem` throws, *other* state writes silently fail too — the user
 * loses data with no feedback.
 *
 * IndexedDB has a much larger quota (often hundreds of MB or a
 * fraction of disk), so moving the audio blob there keeps
 * localStorage free for the small JSON state and removes the
 * quota-exceeded data-loss risk.
 *
 * API
 * ---
 *   saveGlobalCustomSound(file)   — persists a CustomSoundFile
 *   loadGlobalCustomSound()        — reads it back (or null)
 *   deleteGlobalCustomSound()      — removes it
 *
 * All functions are no-ops on environments without IndexedDB (older
 * Safari private mode, SSR) — they resolve to null / void.
 */

import type { CustomSoundFile } from '../types';

const DB_NAME = 'nagnagh-audio';
const DB_VERSION = 1;
const STORE_NAME = 'sounds';
const GLOBAL_SOUND_KEY = 'global-custom-sound';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase | null> {
  if (!isIndexedDBAvailable()) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((err) => {
      console.warn('[audioStore] Failed to open IndexedDB:', err);
      return null;
    });
  }
  return dbPromise;
}

/**
 * Persist the global custom sound file to IndexedDB.
 */
export async function saveGlobalCustomSound(
  file: CustomSoundFile
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(file, GLOBAL_SOUND_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[audioStore] saveGlobalCustomSound failed:', err);
  }
}

/**
 * Load the global custom sound file from IndexedDB.
 * Returns null if not stored, unavailable, or on error.
 */
export async function loadGlobalCustomSound(): Promise<CustomSoundFile | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<CustomSoundFile | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(GLOBAL_SOUND_KEY);
      req.onsuccess = () => resolve((req.result as CustomSoundFile) || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[audioStore] loadGlobalCustomSound failed:', err);
    return null;
  }
}

/**
 * Remove the global custom sound from IndexedDB.
 */
export async function deleteGlobalCustomSound(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(GLOBAL_SOUND_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[audioStore] deleteGlobalCustomSound failed:', err);
  }
}
