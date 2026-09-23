/**
 * Deterministic repository architecture verification entry point.
 *
 * Intentionally runs the existing structural gates directly with Node.
 * It does not install dependencies and does not invoke npm/npx.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  'scripts/test-auto-deduction-business-adapter-phase3.mjs',
  'scripts/test-auto-deduction-scheduling-adapter.mjs',
];

for (const relativeScript of checks) {
  console.log(`\\n==> node ${relativeScript}`);
  const result = spawnSync(process.execPath, [path.join(root, relativeScript)], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.error(`ERROR: failed to start ${relativeScript}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`ERROR: architecture gate failed: ${relativeScript}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\\nPASS: all repository architecture gates');
