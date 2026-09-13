/**
 * Can the app actually draw the languages it offers? (UC-2.R5)
 *
 * This is the test the Hebrew gap needed and nobody could write. The claim in
 * `src/i18n/README.md` was that "Noto Naskh Arabic and Outfit have no Hebrew
 * glyphs, so every Hebrew string would render as tofu" — true, load-bearing,
 * and asserted nowhere, so adding `he` to the picker would have been a green
 * suite and a screen of □□□.
 *
 * ── What is checkable here, and what is not ──────────────────────
 *
 * A font either has a glyph for a codepoint or it does not, and that fact is in
 * the file: the `cmap` table maps codepoints to glyph ids. Jest can read the
 * `.ttf` binaries that `expo-font` will register and answer the question
 * exactly — no device, no screenshot, no eyeballing. The vertical metrics in
 * `head` and `hhea` are in there too, which is what makes `LINE_HEIGHT` a
 * measurement rather than a preference.
 *
 * What is **not** checkable here, and is left to the device issue:
 *
 *   - Rasterisation. That the glyph draws, at the sizes the design uses, with
 *     the hinting the platform picks. A cmap entry is a promise of a glyph, not
 *     a promise that it looks right.
 *   - Shaping. Hebrew is simple compared to Arabic — no joining forms — but
 *     nikud positioning and the final forms (ך ם ן ף ץ) are the shaper's job,
 *     and the shaper is CoreText or HarfBuzz, not this process.
 *   - That `useFonts(fontMap)` succeeded at runtime. `App.tsx` holds the splash
 *     until it resolves; a simulator run is the only thing that proves it.
 *   - Whether the line box the design asks for clips anything *optically*. The
 *     assertions below prove a face cannot be clipped by its own declared box.
 *     Noto Naskh Arabic is deliberately set tighter than that and is fine on a
 *     device — which is exactly why the numbers are pinned here rather than
 *     recomputed from the font at runtime.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { family, fontMap, LINE_HEIGHT, type Script, type Weight } from '../fonts';

const WEIGHTS: Weight[] = [400, 500, 600, 700];
const SCRIPTS: Script[] = ['latin', 'arabic', 'hebrew'];

/** Where the binary for a registered family name lives. */
function ttfPath(familyName: string): string {
  const [face, weight] = familyName.split('_');
  // NotoSansHebrew → noto-sans-hebrew, the @expo-google-fonts package name.
  const pkg = (face ?? '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return join(__dirname, '..', '..', '..', 'node_modules', '@expo-google-fonts', pkg, weight ?? '', `${familyName}.ttf`);
}

type Metrics = { unitsPerEm: number; ascent: number; descent: number; lineGap: number };

function tableDirectory(font: Buffer): Record<string, number> {
  const count = font.readUInt16BE(4);
  const offsets: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 16;
    offsets[font.toString('ascii', entry, entry + 4)] = font.readUInt32BE(entry + 8);
  }
  return offsets;
}

function metricsOf(font: Buffer): Metrics {
  const tables = tableDirectory(font);
  const head = tables.head!;
  const hhea = tables.hhea!;
  return {
    unitsPerEm: font.readUInt16BE(head + 18),
    ascent: font.readInt16BE(hhea + 4),
    // Negative in the file, by convention: it is measured down from the baseline.
    descent: font.readInt16BE(hhea + 6),
    lineGap: font.readInt16BE(hhea + 8),
  };
}

/**
 * Every codepoint the font has a glyph for.
 *
 * Only the two subtable formats these fonts actually use are read — format 4
 * (the BMP segment mapping every TrueType font must carry) and format 12 (the
 * full 32-bit one). An unknown format is a test that has stopped measuring what
 * it claims to, so it throws rather than returning a quietly smaller set.
 */
function codepointsOf(font: Buffer): Set<number> {
  const cmap = tableDirectory(font).cmap!;
  const covered = new Set<number>();
  const subtables = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const subtable = cmap + font.readUInt32BE(cmap + 8 + i * 8);
    const format = font.readUInt16BE(subtable);
    if (format === 0 || format === 6) continue; // legacy Mac tables, a subset of the others
    if (format === 4) {
      const segments = font.readUInt16BE(subtable + 6) / 2;
      const ends = subtable + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const end = font.readUInt16BE(ends + s * 2);
        const start = font.readUInt16BE(starts + s * 2);
        if (start === 0xffff) continue;
        const delta = font.readInt16BE(deltas + s * 2);
        const rangeOffset = font.readUInt16BE(ranges + s * 2);
        for (let cp = start; cp <= end; cp++) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (cp + delta) & 0xffff;
          else {
            const at = ranges + s * 2 + rangeOffset + (cp - start) * 2;
            if (at + 1 >= font.length) continue;
            glyph = font.readUInt16BE(at);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) covered.add(cp);
        }
      }
    } else if (format === 12) {
      const groups = font.readUInt32BE(subtable + 12);
      for (let g = 0; g < groups; g++) {
        const at = subtable + 16 + g * 12;
        const start = font.readUInt32BE(at);
        const end = font.readUInt32BE(at + 4);
        for (let cp = start; cp <= end; cp++) covered.add(cp);
      }
    } else {
      throw new Error(`unhandled cmap format ${format}`);
    }
  }
  return covered;
}

function loadFace(script: Script, weight: Weight = 400) {
  const font = readFileSync(ttfPath(family(weight, script)));
  return { covered: codepointsOf(font), metrics: metricsOf(font) };
}

/** How many codepoints of an inclusive range the face covers. */
function countIn(covered: Set<number>, from: number, to: number): number {
  let found = 0;
  for (let cp = from; cp <= to; cp++) if (covered.has(cp)) found++;
  return found;
}

// א through ת — the 22 letters plus the five final forms, contiguous in Unicode.
const HEBREW_LETTERS: [number, number] = [0x05d0, 0x05ea];
// The combining marks: nikud, dagesh, and the cantillation of the Hebrew Bible.
const HEBREW_MARKS: [number, number] = [0x0591, 0x05c7];
const ARABIC_LETTERS: [number, number] = [0x0621, 0x064a];

describe('every script the picker offers has a face that can draw it', () => {
  it('resolves every weight of every script to a registered, real font file', () => {
    for (const script of SCRIPTS) {
      for (const weight of WEIGHTS) {
        const name = family(weight, script);
        // Registered: App.tsx hands exactly `fontMap` to useFonts, so a family
        // name that is not a key of it is a name no device will have loaded.
        expect({ script, weight, registered: name in fontMap }).toEqual({ script, weight, registered: true });
        expect(() => readFileSync(ttfPath(name))).not.toThrow();
      }
    }
  });

  it('registers nothing it does not use', () => {
    const used = SCRIPTS.flatMap(script => WEIGHTS.map(weight => family(weight, script)));
    expect(Object.keys(fontMap).sort()).toEqual([...used].sort());
  });

  it('draws Hebrew — letters, final forms and the combining marks', () => {
    for (const weight of WEIGHTS) {
      const { covered } = loadFace('hebrew', weight);
      expect({ weight, letters: countIn(covered, ...HEBREW_LETTERS) }).toEqual({ weight, letters: 27 });
      // Not "at least one": pointed text and a pasted name are where a partial
      // mark set shows up, and it shows up as a floating dot on the wrong glyph.
      expect(countIn(covered, ...HEBREW_MARKS)).toBeGreaterThan(40);
    }
  });

  it('is why a third face had to be added: neither old face has a single Hebrew letter', () => {
    // The README's claim, now measured. If a future Outfit release adds Hebrew
    // this goes red and somebody gets to delete a font from the bundle.
    for (const script of ['latin', 'arabic'] as const) {
      const { covered } = loadFace(script);
      expect({ script, letters: countIn(covered, ...HEBREW_LETTERS) }).toEqual({ script, letters: 0 });
    }
  });

  it('keeps Arabic on the Arabic face and does not ask the Hebrew one for it', () => {
    expect(countIn(loadFace('arabic').covered, ...ARABIC_LETTERS)).toBeGreaterThan(40);
    expect(countIn(loadFace('hebrew').covered, ...ARABIC_LETTERS)).toBe(0);
  });

  it('keeps digits on every face, because `<Txt latin>` is an option and not a rule', () => {
    for (const script of SCRIPTS) {
      const { covered } = loadFace(script);
      expect({ script, digits: countIn(covered, 0x30, 0x39) }).toEqual({ script, digits: 10 });
    }
  });
});

describe('the line box each script is given', () => {
  /** The box the face itself asks for, in ems. */
  const naturalBox = (script: Script): number => {
    const { unitsPerEm, ascent, descent, lineGap } = loadFace(script).metrics;
    return (ascent - descent + lineGap) / unitsPerEm;
  };

  for (const script of ['latin', 'hebrew'] as const) {
    it(`${script}: cannot clip — the app's line height clears the face's own box`, () => {
      expect(LINE_HEIGHT[script]).toBeGreaterThanOrEqual(naturalBox(script));
    });
  }

  it('Arabic is set tighter than its own box, on purpose and on the record', () => {
    // Noto Naskh's box is 1.70 em, which pushes the design's rhythm apart.
    // Round 1 tightened it to 1.6 and pays for it with `<Txt latin>` where the
    // clipping bites (AGENTS.md). Pinned so "1.6 < 1.70, must be a bug" is a
    // conversation with a test rather than a silent change.
    expect(LINE_HEIGHT.arabic).toBeLessThan(naturalBox('arabic'));
    expect(LINE_HEIGHT.arabic).toBe(1.6);
  });

  it('gives Hebrew more room than Latin and less than Arabic', () => {
    // The order is the order of the three faces' own boxes: 1.26, 1.36, 1.70.
    expect(naturalBox('latin')).toBeLessThan(naturalBox('hebrew'));
    expect(naturalBox('hebrew')).toBeLessThan(naturalBox('arabic'));
    expect(LINE_HEIGHT.latin).toBeLessThan(LINE_HEIGHT.hebrew);
    expect(LINE_HEIGHT.hebrew).toBeLessThan(LINE_HEIGHT.arabic);
  });
});
