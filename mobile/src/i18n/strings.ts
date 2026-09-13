// Copy for the round-1 design (Claude Design · MaybeSitter.dc.html).
// Arabic is the default language; English mirrors it.
//
// The copy itself now lives in ./locales/{en,ar,he}.json so i18next can read it
// and so the three files can be checked for parity. This module stays as the
// screens' view of it: a plain object keyed by language, with no lookup cost.
// Three count messages (confirmN, lockedTitle, progressWords) are ICU plurals
// that `fill` cannot render — read those through `tr` from useApp() instead.
import ar from './locales/ar.json';
import en from './locales/en.json';
import he from './locales/he.json';

/**
 * Every language the UI can be rendered in.
 *
 * Hebrew joined in UC-2.R5: it is the same union as `Locale` in `locale.ts` on
 * purpose, because there is no longer a locale the app carries copy for but
 * cannot show. The two stay separate types only because this one is the
 * screens' view of the copy and that one is i18next's.
 *
 * Hebrew's copy is machine translated and says so — `he.json` carries
 * `_meta.machine_translated`, `UNREVIEWED_LOCALES` in `locale.ts` names it, and
 * a test binds the two together. It is offered, not vouched for.
 */
export type Lang = 'ar' | 'en' | 'he';

/** The shape of one locale file. English is the template. */
export type Strings = typeof en;

// Typed as Record<Lang, Strings>, so a key missing from ar.json or he.json
// fails tsc — the parity test's job, done again by the compiler.
export const strings: Record<Lang, Strings> = { ar, en, he };

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''));
}

// Keeps times such as "9:00" left-to-right inside Arabic sentences.
export { ltr } from './bidi';
