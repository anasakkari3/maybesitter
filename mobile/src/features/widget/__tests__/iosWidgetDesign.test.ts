/**
 * The iOS widget wears the app's clothes (owner request, 2026-11-19).
 *
 * Xcode is not in the Jest loop, so these read the committed Swift as text, the
 * way `nativeContract.test.ts` does, and hold it to the app's own tokens:
 *
 *  - the widget's palette is `src/theme/tokens.ts`, value for value, in both
 *    schemes — it used to carry the retired teal;
 *  - every text/background pair the widget draws passes WCAG AA;
 *  - every family the home and lock screen offer is supported, and the small
 *    family — which iOS gives one tap target, not many — does not use `Link`;
 *  - the date formatters are built once, not on every timeline read.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { color } from '../../../theme/tokens';

const TARGET = join(__dirname, '..', '..', '..', '..', 'targets', 'widget');
const read = (file: string) => readFileSync(join(TARGET, file), 'utf8');

const palette = read('WidgetPalette.swift');
const entry = read('NextStepWidget.swift');
const views = read('WidgetViews.swift');
const snapshot = read('Snapshot.swift');

type Rgba = { rgb: string; alpha: number };

/** `#RRGGBB` or `rgba(r,g,b,a)` from tokens.ts, as hex digits and alpha. */
function parseToken(value: string): Rgba {
  if (value.startsWith('#')) return { rgb: value.slice(1).toUpperCase(), alpha: 1 };
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(value)!;
  const hex = [m[1]!, m[2]!, m[3]!].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return { rgb: hex.toUpperCase(), alpha: Number(m[4]) };
}

/** The `name: 0xRRGGBB` and `nameOpacity: 0.15` pairs inside `static let <scheme> = WidgetPalette(…)`. */
function swiftScheme(scheme: 'light' | 'dark'): Record<string, Rgba> {
  const body = palette.split(`static let ${scheme} = WidgetPalette(`)[1]!.split('\n  )')[0]!;
  const out: Record<string, Rgba> = {};
  for (const m of body.matchAll(/(\w+): 0x([0-9A-Fa-f]{6})/g)) {
    const opacity = new RegExp(`${m[1]}Opacity: ([\\d.]+)`).exec(body);
    out[m[1]!] = { rgb: m[2]!.toUpperCase(), alpha: opacity ? Number(opacity[1]) : 1 };
  }
  return out;
}

/** Swift role → tokens.ts role. */
const ROLES = {
  background: 'background',
  surface: 'surface',
  surfaceAlt: 'surfaceAlt',
  textPrimary: 'textPrimary',
  textMuted: 'textMuted',
  brand: 'brand',
  brandContainer: 'brandContainer',
  onBrand: 'onBrand',
  must: 'must',
  success: 'success',
  successContainer: 'successContainer',
} as const;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the widget palette is the app palette', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: every role equals tokens.ts`, () => {
      const swift = swiftScheme(scheme);
      for (const [swiftRole, tokenRole] of Object.entries(ROLES)) {
        const expected = parseToken(color[scheme][tokenRole]);
        expect({ role: swiftRole, ...swift[swiftRole] }).toEqual({ role: swiftRole, ...expected });
      }
    });

    it(`${scheme}: every pair the widget draws passes WCAG AA text contrast`, () => {
      const p = swiftScheme(scheme);
      const pairs: [string, string][] = [
        ['textPrimary', 'surface'],
        ['textPrimary', 'background'],
        ['textMuted', 'surface'],
        ['textMuted', 'background'],
        ['onBrand', 'brand'],
        ['brand', 'surface'],
        ['brand', 'background'],
        ['must', 'surface'],
        ['must', 'background'],
        ['success', 'surface'],
      ];
      for (const [fg, bg] of pairs) {
        expect({ pair: `${fg} on ${bg}`, ok: contrast(p[fg]!.rgb, p[bg]!.rgb) >= 4.5 }).toEqual({
          pair: `${fg} on ${bg}`,
          ok: true,
        });
      }
    });
  }

  it('keeps no trace of the retired teal anywhere in the target', () => {
    const everything = [palette, entry, views, snapshot, read('expo-target.config.js')].join('\n');
    for (const teal of ['1F7A8C', '6FC3D6', '1A2023', '14181B']) {
      expect(everything.toUpperCase()).not.toContain(teal);
    }
  });

  it('has one source of colour: Swift, not a second asset-catalog copy', () => {
    expect(read('expo-target.config.js')).not.toMatch(/colors:\s*\{/);
    expect(views).not.toMatch(/Color\("/);
    expect(entry).not.toMatch(/Color\("/);
  });
});

describe('the families', () => {
  it('offers every home-screen and lock-screen family', () => {
    const block = /\.supportedFamilies\(\[([^\]]*)\]\)/.exec(entry)![1]!;
    for (const family of [
      'systemSmall',
      'systemMedium',
      'systemLarge',
      'accessoryRectangular',
      'accessoryCircular',
      'accessoryInline',
    ]) {
      expect(block).toContain(`.${family}`);
    }
  });

  it('reads every lock-screen family as the lock-screen surface', () => {
    expect(views).toMatch(
      /case \.accessoryInline, \.accessoryRectangular, \.accessoryCircular: return \.lockScreen/,
    );
  });

  it('gives the small family one tap target: widgetURL, never Link', () => {
    const small = views.split('struct SmallWidgetView')[1]!.split(/\nstruct |\nprivate struct |\nextension /)[0]!;
    expect(small).toContain('.widgetURL(');
    expect(small).not.toContain('Link(');
  });

  it('draws a placeholder while WidgetKit has nothing to show yet', () => {
    expect(entry).toMatch(/\.redacted\(reason: \.placeholder\)|isPlaceholder/);
  });

  it('never draws a title outside privacySensitive', () => {
    const lines = views.split('\n');
    const draws = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /Text\((item|first|hero|row)\.title\)/.test(line));
    expect(draws.length).toBeGreaterThanOrEqual(5);
    for (const { i } of draws) {
      const window = lines.slice(i, i + 6).join('\n');
      expect(window).toContain('.privacySensitive()');
    }
  });
});

describe('speed', () => {
  it('builds its date formatters once', () => {
    const parse = snapshot.split('static func parseDate')[1]!.split('\n  }')[0]!;
    expect(parse).not.toContain('ISO8601DateFormatter()');
    expect(snapshot).toMatch(/static let \w+: ISO8601DateFormatter/);
  });

  it('does not wake the widget on a fixed 30-minute beat once the snapshot is stale', () => {
    expect(entry).not.toMatch(/byAdding: \.minute, value: 30, to: entries\.last!\.date/);
  });
});
