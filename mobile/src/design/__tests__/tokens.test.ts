import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { color, motion, radius, typeScale, typeScaleR2, type ColorRoles, type Scheme } from '../../theme/tokens';
import source from '../tokens.source.json';
import continuation from '../coral.source.json';
import stitch from '../stitch.source.json';

const repoRoot = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

describe('design tokens are tied to the export', () => {
  // If someone re-exports the design, the manifest sha changes and this fails
  // until the tokens are re-derived. That is the point: tokens may not drift
  // away from the design source silently.
  it('pin the sha256 of the export manifest', () => {
    const manifest = read(join('design', 'EXPORT_MANIFEST.json'));
    const sha = createHash('sha256').update(manifest).digest('hex');
    expect(source.sourceManifestSha).toBe(sha);
  });

  it('every exported file still matches its manifest hash', () => {
    const manifest = JSON.parse(read(join('design', 'EXPORT_MANIFEST.json'))) as {
      files: { path: string; sha256: string }[];
    };
    for (const file of manifest.files) {
      const bytes = readFileSync(join(repoRoot, 'design', file.path));
      expect(`${file.path}:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
        `${file.path}:${file.sha256}`,
      );
    }
  });

  it('matches the approved Stitch redesign on every color role', () => {
    expect(color).toEqual(stitch.colors);
  });

  it('pins every Stitch reference file it was derived from', () => {
    // A re-export of the Stitch design changes these hashes, and this fails
    // until the tokens are looked at again.
    expect(stitch.references).toHaveLength(24);
    for (const ref of stitch.references) {
      const bytes = readFileSync(join(repoRoot, 'docs', 'design', 'stitch-2026-10-02', ref.file));
      expect(`${ref.file}:${createHash('sha256').update(bytes).digest('hex')}`).toBe(`${ref.file}:${ref.sha256}`);
    }
  });

  it('holds the values the Stitch spec names', () => {
    // IMPLEMENTATION_SPEC.md § Tokens, verbatim.
    expect(color.dark.background).toBe('#0E1526');
    expect(color.dark.surface).toBe('#172036');
    expect(color.dark.surfaceAlt).toBe('#1F2A44');
    expect(color.dark.brand).toBe('#FF6B6B');
    expect(color.dark.onBrand).toBe('#0E1526');
    expect(color.dark.must).toBe('#F5B547');
    expect(color.dark.success).toBe('#4CC38A');
    expect(color.light.background).toBe('#F7F5F1');
    expect(color.light.brand).toBe('#C2394A');
    expect(color.light.onBrand).toBe('#FFFFFF');
    expect(color.light.must).toBe('#7A5200');
    expect(color.light.mustContainer).toBe('#FDF1DA');
    expect(color.light.success).toBe('#1E6B45');
    expect(color.light.successContainer).toBe('#E2F5EA');
    expect(radius.card).toBe(stitch.radius.card);
    expect(radius.chip).toBe(stitch.radius.chip);
  });

  it('keeps the R2 type ramp and motion, with nothing below 12', () => {
    expect(typeScale.display).toBe(source.typeScale.display);
    expect(typeScale.body).toBe(source.typeScale.body);
    expect(motion.screenIn).toBe(source.motion.screenIn.duration);
    expect(Math.min(...Object.values(typeScale))).toBe(12);
    expect(Math.min(...Object.values(typeScaleR2))).toBe(12);
  });

  it('retains the historical R2 and coral sources without silently rewriting them', () => {
    expect(source.deviations).toHaveLength(0);
    expect(continuation.authority).toContain('Supersedes the R2 teal palette');
    expect(continuation.references).toHaveLength(15);
    expect(stitch.authority).toContain('replaces the coral continuation');
  });
});

// WCAG 2.1 relative luminance and contrast. The dark scheme's containers are
// translucent tints (`rgba(255,107,107,0.15)`), so a colour is composited over
// the surface it is actually painted on before it is measured.
type Rgba = [number, number, number, number];
function parse(value: string): Rgba {
  if (value.startsWith('#')) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)).concat(1) as Rgba;
  const parts = value.replace(/rgba?\(|\)/g, '').split(',').map(Number);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}
function over(value: string, base: string): [number, number, number] {
  const [r, g, b, a] = parse(value);
  const [br, bg, bb] = parse(base);
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}
function luminance(rgb: readonly number[]): number {
  const linear = rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

/** Contrast of `fg` on `bg`, each composited over the scheme's surface first. */
function contrast(fg: string, bg: string, surface = '#FFFFFF'): number {
  const back = over(bg, surface);
  const front = over(fg, `#${back.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`);
  const [hi, lo] = [luminance(front), luminance(back)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('text contrast meets WCAG AA (4.5:1)', () => {
  const pairs: { name: string; fg: keyof ColorRoles; bg: keyof ColorRoles }[] = [
    { name: 'primary text on background', fg: 'textPrimary', bg: 'background' },
    { name: 'primary text on surface', fg: 'textPrimary', bg: 'surface' },
    { name: 'muted text on background', fg: 'textMuted', bg: 'background' },
    { name: 'muted text on surface', fg: 'textMuted', bg: 'surface' },
    { name: 'label on the brand button', fg: 'onBrand', bg: 'brand' },
    { name: 'brand link on surface', fg: 'brand', bg: 'surface' },
    { name: 'pressed link on surface', fg: 'brandPressed', bg: 'surface' },
    { name: 'success label', fg: 'success', bg: 'successContainer' },
    { name: 'must / attention label', fg: 'must', bg: 'mustContainer' },
    { name: 'coral chip text on its tint', fg: 'brandPressed', bg: 'brandContainer' },
    { name: 'primary text on the raised surface', fg: 'textPrimary', bg: 'surfaceAlt' },
    { name: 'muted text on the raised surface', fg: 'textMuted', bg: 'surfaceAlt' },
    { name: 'tab label on the solid bar', fg: 'textPrimary', bg: 'surfaceBarSolid' },
    { name: 'selected tab on the solid bar', fg: 'brand', bg: 'surfaceBarSolid' },
    { name: 'confirmation check', fg: 'onSuccess', bg: 'success' },
    { name: 'disabled label', fg: 'onDisabled', bg: 'disabled' },
  ];

  for (const scheme of ['light', 'dark'] as Scheme[]) {
    for (const pair of pairs) {
      it(`${scheme}: ${pair.name}`, () => {
        const ratio = contrast(color[scheme][pair.fg], color[scheme][pair.bg], color[scheme].surface);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('rejects white labels on the dark scheme\'s bright coral', () => {
    // Stitch puts navy on coral in dark; white would be 2.6:1.
    expect(contrast('#FFFFFF', color.dark.brand)).toBeLessThan(4.5);
    expect(color.dark.onBrand).toBe(color.dark.background);
  });
});
