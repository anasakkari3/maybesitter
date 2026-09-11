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

export type Lang = 'ar' | 'en';

/** The shape of one locale file. English is the template. */
export type Strings = typeof en;

// Typed as Record<Lang, Strings>, so a key missing from ar.json fails tsc.
export const strings: Record<Lang, Strings> = { ar, en };

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ''));
}

// Keeps times such as "9:00" left-to-right inside Arabic sentences.
export { ltr } from './bidi';
