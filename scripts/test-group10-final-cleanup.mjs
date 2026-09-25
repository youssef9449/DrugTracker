import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// #348 — retired production notification compatibility facade.
assert(!exists('src/utils/notifications.ts'), '#348: production notification compatibility facade must remain removed');

// #350 — native plugin type assertions belong in one boundary module.
const native = read('src/native.ts');
assert(!native.includes('as unknown as'), '#350: src/native.ts must not contain an ad-hoc native plugin type escape');
assert(native.includes('./utils/nativeAppSettings'), '#350: native app-settings capability must be routed through its typed boundary');

// #352 — debounced pharmacy persistence must flush on real page teardown.
const persistentEffect = read('src/hooks/usePersistentEffect.ts');
assert(persistentEffect.includes("addEventListener('pagehide'"), '#352: debounced persistence must flush on pagehide');
assert(persistentEffect.includes("addEventListener('beforeunload'"), '#352: debounced persistence must flush on beforeunload');

// #353/#354 — hydration uses safe storage and runtime record validation.
const hydration = read('src/hooks/useAppHydration.ts');
const hydrationPhases = read('src/utils/appHydrationPhases.ts');
assert(!hydration.includes('localStorage.getItem('), '#353: hydration coordinator must not read localStorage directly');
assert(hydration.includes('readStorageItem(') || hydrationPhases.includes('readStorageItem('), '#353: hydration must use the safe storage reader');
assert(hydration.includes('isValidMedicationRecord') || hydrationPhases.includes('isValidMedicationRecord'), '#354: hydration must validate Medication records');
assert(hydration.includes('isValidConsumptionLogRecord') || hydrationPhases.includes('isValidConsumptionLogRecord'), '#354: hydration must validate ConsumptionLog records');

// #355 — Service Worker must be emitted through the bundle, not rewritten in dist.
const vite = read('vite.config.ts');
assert(vite.includes('this.emitFile('), '#355: Vite must emit sw.js through Rollup output');
assert(!vite.includes('writeFileSync'), '#355: Vite must not write dist/sw.js directly');
assert(!vite.includes("path.resolve(__dirname, 'dist', 'sw.js')"), '#355: Vite must not target dist/sw.js directly');

// #356/#357 — one relative PWA path model + complete emitted asset precache.
const main = read('src/main.tsx');
const index = read('index.html');
const manifest = JSON.parse(read('public/manifest.json'));
const sw = read('public/sw.js');
assert(main.includes(".register('./sw.js')"), '#356: Service Worker registration must be relative');
assert(index.includes('href="./manifest.json"'), '#356: manifest link must be relative');
assert(manifest.start_url === './' && manifest.scope === './', '#356: manifest root/scope must be relative');
assert(manifest.icons.every((icon) => icon.src.startsWith('./')), '#356: manifest icon paths must be relative');
assert(manifest.shortcuts.every((shortcut) => shortcut.url.startsWith('./')), '#356: manifest shortcut paths must be relative');
assert(sw.includes('const APP_BASE_URL = new URL(\'./\''), '#356: Service Worker must derive its deployment base from its own URL');
assert(sw.includes('const PRECACHE_ASSETS = /* __PRECACHE_ASSETS__ */ [];'), '#357: Service Worker source must expose the Vite precache injection placeholder');
assert(sw.includes("drug-tracker-__CACHE_VERSION__"), '#543: Service Worker source must expose the cache-version placeholder');

// #430 — do not send non-Chromium browsers to a chrome:// settings URL.
const webNotifications = read('src/utils/notifications/webNotifications.ts');
assert(webNotifications.includes('isChromiumNotificationSettingsSupported'), '#430: settings navigation must perform browser capability detection');
assert(webNotifications.includes('chrome://settings/content/notifications'), '#430: Chromium-specific settings destination must remain available');
console.log('Group 10 architecture cleanup gate passed.');
