// Intl pieces Hermes does not ship, loaded before anything formats a message.
//
// Hermes implements Intl.Collator, NumberFormat, DateTimeFormat and
// getCanonicalLocales, but not Intl.PluralRules or Intl.Locale
// (facebook/hermes doc/IntlAPIs.md). intl-messageformat throws on every
// `{n, plural, …}` without PluralRules, and i18next-icu then returns the raw
// message — the Today card read "Today, {n, plural, one{# thing} …}" on device
// while Jest, running on Node's full Intl, stayed green.
// src/i18n/__tests__/hermesPlurals.test.ts reproduces that engine.
//
// Order matters: PluralRules needs Locale, Locale needs getCanonicalLocales.
// The -force entry points follow formatjs's React Native advice: the
// conditional detection is slow on Android, and Hermes never has these anyway.
import '@formatjs/intl-getcanonicallocales/polyfill.js';
import '@formatjs/intl-locale/polyfill-force.js';
import '@formatjs/intl-pluralrules/polyfill-force.js';
import '@formatjs/intl-pluralrules/locale-data/en.js';
import '@formatjs/intl-pluralrules/locale-data/ar.js';
import '@formatjs/intl-pluralrules/locale-data/he.js';
