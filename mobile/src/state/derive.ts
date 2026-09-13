import type { Lang, Strings } from '../i18n/strings';
import type { Palette } from '../theme/tokens';
import type { Commitment, Imp } from './types';
import { TODAY } from './seed';

export const fmt = (h: number | null, m = 0): string | null =>
  h == null ? null : `${h}:${String(m || 0).padStart(2, '0')}`;

export function dayLabel(d: number, t: Strings): string {
  if (d === TODAY) return t.today;
  if (d === TODAY + 1) return t.tomorrow;
  if (d === TODAY + 7) return t.nextThu;
  return t.days[d % 7] ?? '';
}

export const impLabel = (i: Imp, t: Strings) => (i === 'must' ? t.mustL : i === 'should' ? t.shouldL : t.niceL);

export function impColors(i: Imp, p: Palette) {
  if (i === 'must') return { bg: p.wms, fg: p.wm };
  if (i === 'should') return { bg: p.acs, fg: p.ac };
  return { bg: p.sf2, fg: p.mu };
}

/**
 * A seed commitment's title in the UI language, falling back to Arabic.
 *
 * The fallback is Arabic rather than English because Arabic is the language
 * the design was written in and the app's default. It is reachable only for
 * Hebrew, and only for this fixture data — see `Localized` in ./types.
 */
export const titleOf = (c: Commitment, lang: Lang) => c.title[lang] || c.title.ar;
