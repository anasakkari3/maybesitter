import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { color, motion, radius, typeScale, type ColorRoles, type Scheme } from '../../theme/tokens';
import source from '../tokens.source.json';

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

  // Round 2 declares its colours as custom properties, so every role can be
  // checked against the export rather than transcribed by eye. Three values
  // were missed exactly that way when this round was imported: the bar alpha
  // in both schemes, and the dark scrim.
  it('match the export on every colour role, in both schemes', () => {
    const declared = (anchor: string): Record<string, string> => {
      const html = read(join('design', 'R2App.dc.html'));
      const found = new RegExp(`['"\`](${anchor}[^'"\`]*)['"\`]`).exec(html);
      if (!found?.[1]) throw new Error(`the export no longer declares ${anchor}`);
      return Object.fromEntries(
        found[1]
          .split(';')
          .filter((pair) => pair.includes(':'))
          .map((pair) => {
            const at = pair.indexOf(':');
            return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
          }),
      );
    };
    // `rgba(26,32,35,.9)` and `rgba(26,32,35,0.90)` are the same colour.
    const canon = (value: string) => {
      const rgba = /^rgba?\(([^)]*)\)$/.exec(value.replace(/\s/g, ''));
      if (!rgba?.[1]) return value.toUpperCase();
      return `rgba(${rgba[1].split(',').map(Number).join(',')})`;
    };
    const roles: Record<keyof ColorRoles, string> = {
      background: '--bg', surface: '--sf', surfaceAlt: '--sf2', surfaceBar: '--sfBar',
      surfaceBarSolid: '--sfBarSolid', textPrimary: '--tx', textMuted: '--mu',
      border: '--ln', borderStrong: '--lnStrong', brand: '--ac', brandContainer: '--acs',
      brandPressed: '--acd', onBrand: '--onac', brandOnInk: '--acOnInk', underline: '--ul',
      must: '--wm', mustContainer: '--wms', disabled: '--dis', onDisabled: '--disTx',
      proposal: '--prop', ink: '--ink', onInk: '--onInk', overlay: '--scrim',
      // `--hatch` is a repeating-linear-gradient in the export; React Native
      // has no gradient, so the app carries the stripe colour out of it and
      // draws the hatch itself. Compared below, not here.
      hatch: '',
    };
    const anchors: Record<Scheme, string> = { light: '--bg:#F5F7F8', dark: '--bg:#101416' };
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      const exported = declared(anchors[scheme]);
      for (const [role, variable] of Object.entries(roles)) {
        if (!variable) continue;
        expect(`${scheme}.${role}=${canon(color[scheme][role as keyof ColorRoles])}`).toBe(
          `${scheme}.${role}=${canon(exported[variable] ?? 'missing')}`,
        );
      }
      const stripe = /rgba?\([^)]*\)/.exec(exported['--hatch'] ?? '')?.[0] ?? 'missing';
      expect(`${scheme}.hatch=${canon(color[scheme].hatch)}`).toBe(`${scheme}.hatch=${canon(stripe)}`);
    }
  });

  it('use the values recorded in tokens.source.json', () => {
    expect(color.light.brand).toBe(source.palette.teal);
    expect(color.dark.brand).toBe(source.palette.tealDark);
    expect(color.light.background).toBe(source.palette.paper);
    expect(color.dark.background).toBe(source.palette.inkDark);
    expect(radius.chip).toBe(source.radius.pill);
    expect(radius.card).toBe(source.radius.card);
    expect(typeScale.display).toBe(source.typeScale.display);
    expect(typeScale.body).toBe(source.typeScale.body);
    expect(motion.screenIn).toBe(source.motion.screenIn.duration);
  });

  // Round 1 put white on the dark accent, which fails contrast, so the app
  // deviated. Round 2 specifies the accessible value itself, so there is
  // nothing left to deviate from — and the app must now match the export
  // exactly rather than carry a private exception.
  it('deviate from the export nowhere', () => {
    expect(source.deviations).toHaveLength(0);
  });

  it('use the dark on-accent value the export now specifies', () => {
    const resolved = source.deviationsResolved[0];
    expect(resolved?.token).toBe('color.dark.onAccent');
    expect(color.dark.onBrand).toBe(resolved?.used);
    expect(color.dark.onBrand).toBe('#101416');
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
  ];

  for (const scheme of ['light', 'dark'] as Scheme[]) {
    for (const pair of pairs) {
      it(`${scheme}: ${pair.name}`, () => {
        const ratio = contrast(color[scheme][pair.fg], color[scheme][pair.bg]);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('proves the check catches the value the export actually specifies', () => {
    // White on the dark accent is what the export says; it fails. This keeps
    // the reason for the deviation visible instead of buried in a comment.
    expect(contrast('#FFFFFF', color.dark.brand)).toBeLessThan(4.5);
  });
});
