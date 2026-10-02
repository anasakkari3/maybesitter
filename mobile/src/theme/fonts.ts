import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import {
  NotoKufiArabic_400Regular,
  NotoKufiArabic_500Medium,
  NotoKufiArabic_600SemiBold,
  NotoKufiArabic_700Bold,
} from '@expo-google-fonts/noto-kufi-arabic';
import {
  NotoSansHebrew_400Regular,
  NotoSansHebrew_500Medium,
  NotoSansHebrew_600SemiBold,
  NotoSansHebrew_700Bold,
} from '@expo-google-fonts/noto-sans-hebrew';

/**
 * Which alphabet a run of text is set in — not which language it is in.
 *
 * A font has glyphs or it does not. Plus Jakarta Sans and Noto Kufi Arabic
 * both cover Latin and both cover **no** Hebrew at all (asserted, against the shipped
 * binaries, in `__tests__/fontCoverage.test.ts`), so a Hebrew UI drawn with
 * either renders every word as tofu. That is why this is a three-value union
 * and not the `arabic: boolean` it used to be: the third language needs a third
 * face, and the boolean had no way to ask for one.
 */
export type Script = 'latin' | 'arabic' | 'hebrew';

// Noto Kufi Arabic for Arabic, Plus Jakarta Sans for Latin and digits (the
// Stitch redesign, 2026-10-02), Noto Sans Hebrew for Hebrew (UC-2.R5,
// unchanged).
export const fontMap = {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  NotoKufiArabic_400Regular,
  NotoKufiArabic_500Medium,
  NotoKufiArabic_600SemiBold,
  NotoKufiArabic_700Bold,
  NotoSansHebrew_400Regular,
  NotoSansHebrew_500Medium,
  NotoSansHebrew_600SemiBold,
  NotoSansHebrew_700Bold,
};

export type Weight = 400 | 500 | 600 | 700;

const suffix: Record<Weight, string> = {
  400: '400Regular',
  500: '500Medium',
  600: '600SemiBold',
  700: '700Bold',
};

const prefix: Record<Script, string> = {
  latin: 'PlusJakartaSans_',
  arabic: 'NotoKufiArabic_',
  hebrew: 'NotoSansHebrew_',
};

/**
 * The line box each script is given, as a multiple of the font size.
 *
 * These are not taste. Each face declares its own box in its `hhea` table, and
 * `__tests__/fontCoverage.test.ts` reads it out of the shipped `.ttf`:
 *
 *   Plus Jakarta Sans  1.26 em  →  1.4 here
 *   Noto Sans Hebrew   1.36 em  →  1.5 here
 *   Noto Kufi Arabic   1.90 em  →  1.7 here
 *
 * Latin and Hebrew are set above their own boxes, so nothing can be clipped.
 * **Arabic is deliberately set below its own**: Kufi declares a box tall
 * enough for stacked marks that ordinary copy never carries, and setting every
 * line at 1.9 would push the design's rhythm apart. Noto Naskh (the previous
 * face, 1.70 em) was set at 1.6 and was fine on device; Kufi is set at 1.7,
 * the same tenth-of-an-em squeeze plus room for its taller letterforms. The
 * `<Txt latin>` escape hatch in `AGENTS.md` is what pays for the tightening
 * where it bites (digits in a calendar circle). That trade is pinned by a test
 * rather than left as folklore.
 *
 * Hebrew gets 1.5 rather than Latin's 1.4 because the square script's box is a
 * tenth of an em taller than Plus Jakarta's, and because Noto Sans Hebrew carries the
 * 55 combining marks (also asserted) that sit below and above the letter — the
 * copy has no points today, but a name somebody types can.
 */
export const LINE_HEIGHT: Record<Script, number> = {
  latin: 1.4,
  arabic: 1.7,
  hebrew: 1.5,
};

/**
 * The registered font-family name for a weight in a script.
 *
 * `false` is accepted as a spelling of `'latin'` because `useApp().ar` has
 * carried the "is this RTL" answer since the app had two languages, and it now
 * carries the RTL *script* instead (see `AppContext`) — so the call sites that
 * still read it keep picking the right face rather than silently picking the
 * Latin one for Hebrew.
 */
export function family(weight: Weight, script: Script | false): string {
  return prefix[script === false ? 'latin' : script] + suffix[weight];
}

const ARABIC_CHARS = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const HEBREW_CHARS = /[֐-׿יִ-ﭏ]/;
const LATIN_LETTERS = /[A-Za-zÀ-ɏ]/;

/**
 * Which face a run of the person's own words needs (UAT 2026-09-30, u27/u28).
 *
 * The UI's script picks the face for copy. Text the person typed can be in any
 * alphabet: an English sentence in the Arabic composer was set in the Arabic
 * face's Latin, unlike every Latin word the app draws in Plus Jakarta Sans.
 * Any Arabic letter keeps Noto Kufi (it covers Latin too); any Hebrew letter
 * keeps Noto Sans Hebrew; Latin letters alone take Plus Jakarta Sans. Digits, punctuation and an empty
 * field say nothing, so they keep the UI's own face (and the placeholder's).
 */
export function scriptOfText(text: string, fallback: Script): Script {
  if (ARABIC_CHARS.test(text)) return fallback === 'hebrew' && HEBREW_CHARS.test(text) ? 'hebrew' : 'arabic';
  if (HEBREW_CHARS.test(text)) return 'hebrew';
  if (LATIN_LETTERS.test(text)) return 'latin';
  return fallback;
}
