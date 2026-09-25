/**
 * Generate PNG icons from icon.svg for PWA manifest and multiple device resolutions.
 *
 * Supports all target densities:
 *   - 16x16, 32x32, 48x48 (favicons / low-dpi)
 *   - 72x72, 96x96, 128x128, 144x144 (medium / high-dpi Android)
 *   - 180x180 (iOS apple-touch-icon)
 *   - 192x192, 384x384, 512x512 (standard & high-dpi PWA)
 *   - 192x192, 512x512 (Android adaptive maskable icons)
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ICONS_DIR = join(REPO_ROOT, 'public', 'assets', 'icons');
const SVG_PATH = join(ICONS_DIR, 'icon.svg');

// Clean white background for Android adaptive maskable icons
const MASKABLE_BG = { r: 255, g: 255, b: 255, alpha: 1 };

async function renderSvgToPng(svgPath, outputPath, size) {
  const svgBuffer = readFileSync(svgPath);
  await sharp(svgBuffer, { density: 300 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outputPath);
}

async function makeMaskableIcon(svgPath, outputPath, size) {
  // Safe zone for Android Adaptive icons is inner 66% (leaving ~17% safe margin)
  const innerSize = Math.round(size * 0.68);
  const offset = Math.round((size - innerSize) / 2);

  const svgBuffer = readFileSync(svgPath);
  const innerPng = await sharp(svgBuffer, { density: 300 })
    .resize(innerSize, innerSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: MASKABLE_BG,
    },
  })
    .composite([{ input: innerPng, left: offset, top: offset }])
    .png()
    .toFile(outputPath);
}

async function main() {
  if (!existsSync(SVG_PATH)) {
    console.error(`ERROR: SVG file not found at ${SVG_PATH}`);
    process.exit(1);
  }

  mkdirSync(ICONS_DIR, { recursive: true });

  const targets = [
    { name: 'icon-16.png', size: 16, purpose: 'any' },
    { name: 'icon-32.png', size: 32, purpose: 'any' },
    { name: 'icon-48.png', size: 48, purpose: 'any' },
    { name: 'icon-72.png', size: 72, purpose: 'any' },
    { name: 'icon-96.png', size: 96, purpose: 'any' },
    { name: 'icon-128.png', size: 128, purpose: 'any' },
    { name: 'icon-144.png', size: 144, purpose: 'any' },
    { name: 'icon-180.png', size: 180, purpose: 'any' }, // iOS Apple Touch icon
    { name: 'icon-192.png', size: 192, purpose: 'any' }, // Android standard PWA
    { name: 'icon-256.png', size: 256, purpose: 'any' },
    { name: 'icon-384.png', size: 384, purpose: 'any' }, // Android xxhdpi
    { name: 'icon-512.png', size: 512, purpose: 'any' }, // Android xxxhdpi
    { name: 'icon-maskable-192.png', size: 192, purpose: 'maskable' },
    { name: 'icon-maskable-512.png', size: 512, purpose: 'maskable' },
  ];

  console.log(`Generating ${targets.length} icon sizes from ${SVG_PATH}...\n`);

  for (const { name, size, purpose } of targets) {
    const output = join(ICONS_DIR, name);
    if (purpose === 'maskable') {
      await makeMaskableIcon(SVG_PATH, output, size);
    } else {
      await renderSvgToPng(SVG_PATH, output, size);
    }
    const { statSync } = await import('node:fs');
    const actual = statSync(output).size;
    console.log(`  ✓ ${name.padEnd(24)} (${size}x${size}, ${purpose}) — ${actual} bytes`);
  }

  console.log('\nAll app icons generated successfully.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
