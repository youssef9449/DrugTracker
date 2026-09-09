import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_PATH = path.resolve(__dirname, '../../public/manifest.json');

/**
 * #26 — the manifest's SVG icon entry must NOT declare `purpose:
 * "any maskable"` because the SVG isn't maskable-safe (its rounded
 * corners fall outside the maskable safe zone and Android's circular
 * mask would reveal empty space). The separately-generated maskable
 * PNGs are the only maskable icons. The SVG should be `purpose: "any"`
 * only.
 */
describe('manifest.json — SVG icon purpose (#26)', () => {
  it('the SVG icon declares purpose "any" only (not "any maskable")', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const svgIcon = manifest.icons.find(
      (i: { src: string }) => i.src === '/assets/icons/icon.svg'
    );
    expect(svgIcon).toBeDefined();
    expect(svgIcon.purpose).toBe('any');
    expect(svgIcon.purpose).not.toContain('maskable');
  });

  it('the maskable PNG icons still declare purpose "maskable"', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const maskableIcons = manifest.icons.filter(
      (i: { purpose: string }) => i.purpose === 'maskable'
    );
    // There should be exactly 2 maskable icons (192 + 512 PNGs).
    expect(maskableIcons.length).toBe(2);
    expect(maskableIcons.every((i: { src: string }) => i.src.includes('maskable'))).toBe(true);
  });

  it('the manifest shortcuts use the ?tab= param for all 3 tabs', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(manifest.shortcuts).toHaveLength(3);
    const urls = manifest.shortcuts.map((s: { url: string }) => s.url);
    expect(urls).toContain('/?tab=stock');
    expect(urls).toContain('/?tab=logs');
    expect(urls).toContain('/?tab=shopping');
  });
});
