import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { color, motion, radius, typeScale, type ColorRoles, type Scheme } from '../../theme/tokens';
import source from '../tokens.source.json';
import continuation from '../coral.source.json';

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

  it('matches the explicitly approved continuation on every color role', () => {
    expect(color).toEqual(continuation.colors);
    expect(continuation.references).toHaveLength(15);
  });

  it('use the values recorded in tokens.source.json', () => {
    expect(color.light.brand).toBe(continuation.colors.light.brand);
    expect(color.dark.brand).toBe(continuation.colors.dark.brand);
    expect(color.light.background).toBe(continuation.colors.light.background);
    expect(color.dark.background).toBe(continuation.colors.dark.background);
    expect(radius.chip).toBe(source.radius.pill);
    expect(radius.card).toBe(source.radius.card);
    expect(typeScale.display).toBe(source.typeScale.display);
    expect(typeScale.body).toBe(source.typeScale.body);
    expect(motion.screenIn).toBe(source.motion.screenIn.duration);
  });

  it('retains the historical R2 source without silently rewriting it', () => {
    expect(source.deviations).toHaveLength(0);
    expect(continuation.authority).toContain('Supersedes the R2 teal palette');
  });
});

// WCAG 2.1 relative luminance and contrast.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
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
    { name: 'confirmation check', fg: 'onSuccess', bg: 'success' },
    { name: 'disabled label', fg: 'onDisabled', bg: 'disabled' },
  ];

  for (const scheme of ['light', 'dark'] as Scheme[]) {
    for (const pair of pairs) {
      it(`${scheme}: ${pair.name}`, () => {
        const ratio = contrast(color[scheme][pair.fg], color[scheme][pair.bg]);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('rejects white labels on bright reference coral', () => {
    // The supplied screenshots use white. The implementation uses ink.
    expect(contrast('#FFFFFF', color.dark.brand)).toBeLessThan(4.5);
  });
});
