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

const rawDir = path.join(androidDir, 'app', 'src', 'main', 'res', 'raw');
fs.mkdirSync(rawDir, { recursive: true });
const soundPath = path.join(rawDir, 'dose_reminder.wav');
if (!fs.existsSync(soundPath)) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * 0.35);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 240, (samples - index) / 240);
    const sample = Math.sin((2 * Math.PI * 880 * index) / sampleRate) * 0.35 * envelope;
    data.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(soundPath, Buffer.concat([header, data]));
}

console.info('Prepared Android exact-alarm permission and dose reminder sound.');