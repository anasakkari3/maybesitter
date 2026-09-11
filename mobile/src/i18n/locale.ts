import i18next from 'i18next';

/**
 * Every locale the app carries copy for. Hebrew is wired end to end but is not
 * offered in the language picker — see SELECTABLE_LOCALES and README.md.
 */
export const LOCALES = ['en', 'ar', 'he'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * The locale used when nothing else resolves. Typed as the literal 'en', not as
 * Locale, so it can also stand in where only a *selectable* locale is allowed.
 */
export const DEFAULT_LOCALE = 'en' as const;

/**
 * What the language picker may offer. Hebrew is missing on purpose: no native
 * speaker has reviewed he.json, and the app ships only Noto Naskh Arabic and
 * Outfit, neither of which has Hebrew glyphs, so it would render as tofu.
 */
export const SELECTABLE_LOCALES = ['en', 'ar'] as const;

/**
 * THE digit decision, in one place. Arabic copy uses Latin digits (`-u-nu-latn`)
 * for times, counts and dates: the audience is Levantine/Israeli, and it keeps
 * the times the backend echoes readable next to the ones the app renders. Drop
 * the extension here to get Arabic-Indic digits (٠١٢…) everywhere at once —
 * ICU plurals, Intl.DateTimeFormat and Intl.NumberFormat all read this map.
 */
export const INTL_LOCALE: Record<Locale, string> = {
  en: 'en',
  ar: 'ar-u-nu-latn',
  he: 'he',
};

/** The BCP-47 tag to hand to `Intl` and `intl-messageformat` for a locale. */
export const intlLocale = (locale: Locale): string => INTL_LOCALE[locale];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * The `en|ar|he` value the backend takes for `locale` on the next-step query and
 * the decision bodies. Accepts any BCP-47 tag ('ar-IL', 'he-IL', the legacy
 * 'iw'), and falls back to English rather than sending something unsupported.
 * Called with no argument it reports the language i18next is currently on.
 */
export function apiLocale(tag: string | null | undefined = i18next.language): Locale {
  const base = (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  // 'iw' is the deprecated ISO 639-1 code for Hebrew and some Android builds
  // still report it.
  if (base === 'iw') return 'he';
  return isLocale(base) ? base : DEFAULT_LOCALE;
}
