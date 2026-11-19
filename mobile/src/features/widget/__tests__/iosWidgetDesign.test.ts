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
import { buildSnapshot, type SnapshotInput } from '../snapshot';
import { DEFAULT_THEME_PREF } from '../../../lib/deviceSettings/theme';
import { widgetLabelsFor } from '../labels';
import { strings } from '../../../i18n/strings';

const TARGET = join(__dirname, '..', '..', '..', '..', 'targets', 'widget');
const read = (file: string) => readFileSync(join(TARGET, file), 'utf8');

const palette = read('WidgetPalette.swift');
const entry = read('NextStepWidget.swift');
const views = read('WidgetViews.swift');
const snapshotRaw = read('Snapshot.swift');
/**
 * Source with its comments stripped — whole-line and trailing — so a comment
 * cannot satisfy a check. `://` is kept: every deep link in the Swift has one.
 */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
const viewCode = code(views);
const snapshot = code(snapshotRaw);

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
      .filter(({ line }) => /Text\((item|first)\.title\)/.test(line));
    expect(draws.length).toBeGreaterThanOrEqual(3);
    // `!placeholder` only steps aside for WidgetKit's sample shapes, which hold no user content.
    for (const { i } of draws) {
      const window = lines.slice(i, i + 6).join('\n');
      expect(window).toMatch(/\.privacySensitive\((!placeholder|!c\.isPlaceholder)?\)/);
    }
    // The inline family draws its title through a mapped string, not `Text(item.title)`.
    expect((viewCode.match(/\.privacySensitive\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(viewCode).not.toMatch(/\.privacySensitive\(\s*(false|true)\s*\)/);
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

describe("the widget wears the app's theme, not the phone's", () => {
  const base: SnapshotInput = {
    today: [],
    nextStep: null,
    titlesAllowed: false,
    surface: 'widget',
    locale: 'ar',
    labels: widgetLabelsFor(strings.ar),
    now: new Date('2026-09-13T09:00:00.000Z'),
    formatTime: () => '',
  };

  it("writes the person's appearance into the snapshot, and the app's own default when there is none", () => {
    expect(buildSnapshot({ ...base, appearance: 'light' }).appearance).toBe('light');
    expect(buildSnapshot({ ...base, appearance: 'system' }).appearance).toBe('system');
    // Nothing chosen means navy dark (Stitch, 2026-10-02) — the same constant the app reads.
    expect(buildSnapshot(base).appearance).toBe(DEFAULT_THEME_PREF);
    expect(DEFAULT_THEME_PREF).toBe('dark');
  });

  it('decodes the appearance as optional, so a snapshot written by an older app still draws', () => {
    expect(snapshot).toMatch(/let appearance: String\?/);
  });

  it('draws dark unless told otherwise, light on request, and the phone only when the person chose "system"', () => {
    const fn = views.split('func resolvedScheme')[1]!.split('\n}')[0]!;
    expect(fn).toMatch(/case "light": return \.light/);
    expect(fn).toMatch(/case "system": return system/);
    expect(fn).toMatch(/default: return \.dark/);
  });

  it('hands the resolved scheme, not the phone\'s, to the palette and to the home-screen views', () => {
    expect(views).toMatch(/WidgetPalette\.of\(resolved,/);
    expect(views).toMatch(/\.environment\(\\\.colorScheme, content\.resolved\)/);
  });
});

describe('privacy, checked in code and not in comments', () => {
  it('reads each family from its own surface, so the lock screen never gets the home screen\'s titles', () => {
    expect(viewCode).toContain('snapshot.safeItems(on: surface(for: family))');
    expect(viewCode).not.toMatch(/safeItems\(on: (WidgetSurface)?\.widget\)/);
  });

  it('only WidgetKit\'s own placeholder switches the privacy marking off', () => {
    expect(viewCode).toMatch(/isPlaceholder = entry\.isPlaceholder/);
    expect(viewCode).not.toMatch(/isPlaceholder\s*[:=]\s*true/);
  });

  it('keeps the inline family\'s title marked privacy-sensitive', () => {
    const lines = viewCode.split('\n');
    const at = lines.findIndex((line) => line.includes('first.timeLabel.map'));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at, at + 4).join('\n')).toMatch(/\.privacySensitive\(!c\.isPlaceholder\)/);
  });

  it('SafeItem and the surface check redact in Swift, not only in the app', () => {
    expect(snapshot).toMatch(/mode == "allowedSurfacesOnly" && allowedSurfaceIds\.contains\(surface\.rawValue\)/);
    expect(snapshot).toMatch(/let show = allowed && !item\.titleRedacted && !item\.title\.isEmpty/);
    expect(snapshot).toMatch(/title = show \? item\.title : redacted/);
  });
});

describe('the tinted and clear icon modes (iOS 18)', () => {
  it('reads the rendering mode and flattens its fills outside full colour', () => {
    expect(viewCode).toMatch(/@Environment\(\\\.widgetRenderingMode\)/);
    expect(viewCode).toMatch(/fullColor: renderingMode == \.fullColor/);
    const palette = code(read('WidgetPalette.swift'));
    expect(palette).toMatch(/fullColor \? color : Color\.primary\.opacity/);
    // The three fills that sit under text or an icon go through it.
    for (const role of ['card', 'accentSoft', 'doneSoft']) {
      expect(palette).toMatch(new RegExp(`var ${role}: Color \\{ fill\\(`));
    }
  });

  it('hands the rendering mode on from the family view to the content, not a constant', () => {
    expect(viewCode).toMatch(/WidgetContent\(entry: entry, family: family, scheme: scheme, fullColor: fullColor\)/);
  });

  it('keeps the capture word legible when the capsule cannot be a solid fill', () => {
    expect(viewCode).toMatch(/p\.fullColor \? p\.onAccent : p\.ink/);
    expect(viewCode).toMatch(/strokeBorder/);
  });
});

/**
 * A note on what these checks are. Xcode is not in the Jest loop, so every
 * Swift check above reads text: it holds the shape of the code, not what the
 * code does when it runs. A condition rewritten as `x || true` keeps the shape.
 * The behavioural cover is `FamilyView` rendered per family and scheme to
 * images (see the PR that introduced this file) and, one day, an XCTest target
 * for `SafeItem` and `resolvedScheme`.
 */
