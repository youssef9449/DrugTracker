/**
 * Generate PNG icons from icon.svg for the PWA manifest (#120).
 *
 * Replaces the previous Python script (scripts/generate-icons.py) which
 * required cairosvg + Pillow — undocumented deps that broke on Windows
 * (python3 vs python). This Node script uses sharp (a cross-platform
 * native image library) so it works on all platforms with no external
 * Python dependencies.
 *
 * The PWA manifest references these PNG icons:
 *   - /icon-180.png          (180x180, any — iOS apple-touch-icon preferred size #119)
 *   - /icon-192.png           (192x192, any purpose)
 *   - /icon-512.png           (512x512, any purpose)
 *   - /icon-maskable-192.png  (192x192, maskable)
 *   - /icon-maskable-512.png  (512x512, maskable)
 *
 * The "any" icons render the SVG as-is onto a transparent background
 * (except for the rounded square background baked into the SVG).
 *
 * The "maskable" icons add extra padding so that Android's adaptive-icon
 * masking doesn't crop the bell. Android's safe zone for maskable icons
 * is a circle with radius = 80 / 192 ≈ 41.7% of the icon width, centered.
 * We place the bell content within the inner 66% of the icon, leaving a
 * ~17% safe padding on every side.
 *
 * Usage:
 *     node scripts/generate-icons.mjs
 *     # or via npm:
 *     npm run icons
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ICONS_DIR = join(REPO_ROOT, 'public', 'assets', 'icons');
const SVG_PATH = join(ICONS_DIR, 'icon.svg');

// Teal-800 (#0f766e) for the maskable icon background.
const MASKABLE_BG = { r: 15, g: 118, b: 110, alpha: 1 };

async function renderSvgToPng(svgPath, outputPath, size) {
  const svgBuffer = readFileSync(svgPath);
  await sharp(svgBuffer, { density: 300 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outputPath);
}

async function makeMaskableIcon(svgPath, outputPath, size) {
  const innerSize = Math.round(size * 0.66);
  const offset = Math.round((size - innerSize) / 2);

  // Render the SVG at the inner content size (66% of the target).
  const svgBuffer = readFileSync(svgPath);
  const innerPng = await sharp(svgBuffer, { density: 300 })
    .resize(innerSize, innerSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Composite the inner PNG onto a solid teal background, centered.
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
    { name: 'icon-180.png', size: 180, purpose: 'any' }, // #119: iOS apple-touch-icon preferred size
    { name: 'icon-192.png', size: 192, purpose: 'any' },
    { name: 'icon-512.png', size: 512, purpose: 'any' },
    { name: 'icon-maskable-192.png', size: 192, purpose: 'maskable' },
    { name: 'icon-maskable-512.png', size: 512, purpose: 'maskable' },
  ];

  for (const { name, size, purpose } of targets) {
    const output = join(ICONS_DIR, name);
    if (purpose === 'maskable') {
      await makeMaskableIcon(SVG_PATH, output, size);
    } else {
      await renderSvgToPng(SVG_PATH, output, size);
    }
    const { statSync } = await import('node:fs');
    const actual = statSync(output).size;
    console.log(`  ✓ ${name} (${size}x${size}, ${purpose}) — ${actual} bytes`);
  }

  console.log('\nAll PWA icons generated successfully.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
