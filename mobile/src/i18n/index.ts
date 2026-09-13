// Must stay first: installs Intl.PluralRules/Intl.Locale before intl-messageformat
// formats anything. Hermes has neither — see ./polyfills.ts.
import './polyfills';
import i18next from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';
import en from './locales/en.json';
import he from './locales/he.json';
import { DEFAULT_LOCALE, LOCALES, intlLocale, isLocale, type Locale } from './locale';

export const resources = {
  en: { translation: en },
  ar: { translation: ar },
  he: { translation: he },
};

// i18next-icu hands the message to intl-messageformat with the *i18next*
// language code. That code also picks the numbering system for `#` inside a
// plural and for every {number} argument, so the Latin-digit decision in
// locale.ts has to be applied here or Arabic counts come out as ٣ and ١١.
const icu = new ICU({
  parseLngForICU: lng => (isLocale(lng) ? intlLocale(lng) : lng),
});

// Resources are inline, so there is no loader and init finishes synchronously:
// `t` is usable on the first render and in tests the moment this module loads.
void i18next
  .use(icu)
  .use(initReactI18next)
  .init({
    resources,
    // Arabic is the design's default language; AppContext replaces this as soon
    // as the stored preference (or the device locale) has been read.
    lng: 'ar',
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: LOCALES,
    // ICU owns interpolation. i18next must not escape values or run its own
    // {{...}} pass over a message intl-messageformat has already formatted.
    interpolation: { escapeValue: false },
  });

export default i18next;

/** A `t` bound to one locale, independent of what the UI is currently showing. */
export const tFor = (locale: Locale) => i18next.getFixedT(locale);

export async function setLocale(locale: Locale): Promise<void> {
  if (i18next.language !== locale) await i18next.changeLanguage(locale);
}

export { apiLocale, DEFAULT_LOCALE, intlLocale, isLocale, LOCALES, SELECTABLE_LOCALES } from './locale';
export type { Locale } from './locale';
export { isolate, isolateAuto, ltr, stripIsolates } from './bidi';
export { formatDate, formatNumber, formatRelativeDay, formatTime, formatTimeRange } from './format';
export { deviceTimeZone, FALLBACK_TIME_ZONE, resolveTimeZone, useTimeZone } from './timezone';
