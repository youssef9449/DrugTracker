import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
if (!fs.existsSync(androidDir)) {
  console.error('Android project not found. Run "npx cap add android" once.');
  process.exit(1);
}

const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
const exactPermission = '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />';
manifest = manifest.replace(/\s*<uses-permission android:name="android\.permission\.USE_EXACT_ALARM"\s*\/>/g, '');
if (!manifest.includes(exactPermission)) {
  manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    ${exactPermission}`);
}
fs.writeFileSync(manifestPath, manifest);

// Remove the legacy custom dose-reminder sound if it exists from a previous
// build. The dose-reminder channel (v3) now uses the default system
// notification sound, so the bundled 'dose_reminder.wav' is no longer needed.
const rawDir = path.join(androidDir, 'app', 'src', 'main', 'res', 'raw');
const soundPath = path.join(rawDir, 'dose_reminder.wav');
if (fs.existsSync(soundPath)) {
  fs.unlinkSync(soundPath);
  console.info('Removed legacy dose_reminder.wav (channel now uses system default sound).');
}

console.info('Prepared Android exact-alarm permission.');
