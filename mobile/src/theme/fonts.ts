import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
} from '@expo-google-fonts/outfit';
import {
  NotoNaskhArabic_400Regular,
  NotoNaskhArabic_500Medium,
  NotoNaskhArabic_600SemiBold,
  NotoNaskhArabic_700Bold,
} from '@expo-google-fonts/noto-naskh-arabic';
import {
  NotoSansHebrew_400Regular,
  NotoSansHebrew_500Medium,
  NotoSansHebrew_600SemiBold,
  NotoSansHebrew_700Bold,
} from '@expo-google-fonts/noto-sans-hebrew';

/**
 * Which alphabet a run of text is set in — not which language it is in.
 *
 * A font has glyphs or it does not. Outfit and Noto Naskh Arabic both cover
 * Latin and both cover **no** Hebrew at all (asserted, against the shipped
 * binaries, in `__tests__/fontCoverage.test.ts`), so a Hebrew UI drawn with
 * either renders every word as tofu. That is why this is a three-value union
 * and not the `arabic: boolean` it used to be: the third language needs a third
 * face, and the boolean had no way to ask for one.
 */
export type Script = 'latin' | 'arabic' | 'hebrew';

// Noto Naskh Arabic for Arabic, Noto Sans Hebrew for Hebrew, Outfit for Latin
// (design system, round 1 + the Hebrew face UC-2.R5 added).
export const fontMap = {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  NotoNaskhArabic_400Regular,
  NotoNaskhArabic_500Medium,
  NotoNaskhArabic_600SemiBold,
  NotoNaskhArabic_700Bold,
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
  latin: 'Outfit_',
  arabic: 'NotoNaskhArabic_',
  hebrew: 'NotoSansHebrew_',
};

/**
 * The line box each script is given, as a multiple of the font size.
 *
 * These are not taste. Each face declares its own box in its `hhea` table, and
 * `__tests__/fontCoverage.test.ts` reads it out of the shipped `.ttf`:
 *
 *   Outfit             1.26 em  →  1.4 here
 *   Noto Sans Hebrew   1.36 em  →  1.5 here
 *   Noto Naskh Arabic  1.70 em  →  1.6 here
 *
 * Latin and Hebrew are set above their own boxes, so nothing can be clipped.
 * **Arabic is deliberately set below its own**: Naskh's box is tall enough to
 * push the design's rhythm apart, round 1 tightened it to 1.6 on device, and
 * the `<Txt latin>` escape hatch in `AGENTS.md` is what pays for the tightening
 * where it bites (digits in a calendar circle). That trade is pinned by a test
 * rather than left as folklore, so nobody "fixes" it into 1.7 by symmetry.
 *
 * Hebrew gets 1.5 rather than Latin's 1.4 because the square script's box is a
 * tenth of an em taller than Outfit's, and because Noto Sans Hebrew carries the
 * 55 combining marks (also asserted) that sit below and above the letter — the
 * copy has no points today, but a name somebody types can.
 */
export const LINE_HEIGHT: Record<Script, number> = {
  latin: 1.4,
  arabic: 1.6,
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
