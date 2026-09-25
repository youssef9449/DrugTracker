import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const swPath = path.join(root, 'dist', 'sw.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function collectFiles(dir, prefix = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFiles(full, rel));
    else results.push(rel);
  }
  return results;
}

assert(fs.existsSync(swPath), 'Production build must emit dist/sw.js');

const sw = fs.readFileSync(swPath, 'utf8');
const cacheMatch = sw.match(/const CACHE_NAME = '([^']+)'/);
assert(
  cacheMatch && /^drug-tracker-[a-f0-9]{12}$/.test(cacheMatch[1]),
  'Generated Service Worker must contain a content-derived cache identity'
);

const precacheMatch = sw.match(/const PRECACHE_ASSETS = (\[[\s\S]*?\]);/);
assert(precacheMatch, 'Generated Service Worker must contain the Vite-injected precache asset list');
const precache = JSON.parse(precacheMatch[1]);
assert(Array.isArray(precache), 'Injected precache must be an array');
assert(precache.length > 0, 'Injected precache must not be empty');

const expected = collectFiles(path.join(root, 'dist'))
  .filter((file) => file !== 'sw.js' && /\.(?:js|css)$/i.test(file))
  .sort();
const actual = precache.slice().sort();

assert(
  JSON.stringify(actual) === JSON.stringify(expected),
  'Injected precache mismatch. Expected ' + expected.length +
    ' emitted JS/CSS files, received ' + actual.length + '.'
);
assert(
  actual.every((file) => !file.startsWith('/')),
  'Precache entries must be relative to the deployed app base'
);
console.log(
  'PWA verification passed: ' + expected.length +
    ' JS/CSS assets are pre-cached by emitted sw.js.'
);


async function verifyServiceWorkerInstallFailureBoundary() {
  const installHandlers = [];
  const criticalCache = {
    addAll: async () => {
      throw new Error('critical cache failure');
    },
    add: async () => {
      throw new Error('optional cache failure');
    },
  };

  const criticalContext = {
    URL,
    console,
    caches: {
      open: async () => criticalCache,
      keys: async () => [],
      delete: async () => true,
    },
    self: {
      location: { href: 'https://example.test/' },
      clients: { claim() {} },
      skipWaiting() {},
      addEventListener(type, handler) {
        if (type === 'install') installHandlers.push(handler);
      },
    },
  };

  vm.runInNewContext(sw, criticalContext);
  assert(
    installHandlers.length === 1,
    'Generated Service Worker must register exactly one install handler'
  );

  const waits = [];
  installHandlers[0]({ waitUntil: (promise) => waits.push(promise) });
  assert(waits.length === 1, 'Install handler must register one lifecycle promise');

  let rejected = false;
  try {
    await waits[0];
  } catch {
    rejected = true;
  }
  assert(
    rejected,
    'Critical precache failure must reject the Service Worker install transaction'
  );

  const optionalCalls = [];
  const optionalCache = {
    addAll: async (urls) => {
      optionalCalls.push({ kind: 'critical', urls });
    },
    add: async (url) => {
      optionalCalls.push({ kind: 'optional', url });
      throw new Error('optional cache failure');
    },
  };
  const optionalHandlers = [];
  const optionalContext = {
    URL,
    console,
    caches: {
      open: async () => optionalCache,
      keys: async () => [],
      delete: async () => true,
    },
    self: {
      location: { href: 'https://example.test/' },
      clients: { claim() {} },
      skipWaiting() {},
      addEventListener(type, handler) {
        if (type === 'install') optionalHandlers.push(handler);
      },
    },
  };

  vm.runInNewContext(sw, optionalContext);
  const optionalWaits = [];
  optionalHandlers[0]({ waitUntil: (promise) => optionalWaits.push(promise) });
  await optionalWaits[0];
  assert(
    optionalCalls.some((call) => call.kind === 'critical'),
    'Install must attempt critical precache through cache.addAll'
  );
  assert(
    optionalCalls.some((call) => call.kind === 'optional'),
    'Install must attempt optional resources independently'
  );
}

await verifyServiceWorkerInstallFailureBoundary();
