import i18next from 'i18next';
import type { Script } from '../theme/fonts';

/** Every locale the app carries copy for, and — since UC-2.R5 — can render. */
export const LOCALES = ['en', 'ar', 'he'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * The locale used when nothing else resolves. Typed as the literal 'en', not as
 * Locale, so it can also stand in where only a *selectable* locale is allowed.
 */
export const DEFAULT_LOCALE = 'en' as const;

/**
 * What the language picker may offer.
 *
 * This was `['en', 'ar']` for two reasons, and Hebrew is here because one of
 * them is gone: the app now bundles Noto Sans Hebrew, so Hebrew draws real
 * glyphs instead of tofu (`src/theme/fonts.ts`). The other reason has not gone
 * anywhere — see UNREVIEWED_LOCALES directly below.
 */
export const SELECTABLE_LOCALES = ['en', 'ar', 'he'] as const;

/**
 * Locales whose copy no native speaker has read.
 *
 * `he.json` was derived from the terminology table in the archived Flutter
 * client, not translated by a person, and it says so in its own `_meta`.
 * Offering it is a deliberate trade — a Hebrew speaker reading imperfect Hebrew
 * is better served than one reading English — but it is **not** a claim that
 * the copy is right, and grammatical gender in particular is unreviewed.
 *
 * This constant exists so that status is a fact the code states rather than a
 * paragraph in a README that can quietly stop being true:
 * `__tests__/provenance.test.ts` fails if this list and the `_meta` markers in
 * the locale files ever disagree, in either direction.
 */
export const UNREVIEWED_LOCALES = ['he'] as const;

/**
 * THE digit decision, in one place. Arabic copy uses Latin digits (`-u-nu-latn`)
 * for times, counts and dates: the audience is Levantine/Israeli, and it keeps
 * the times the backend echoes readable next to the ones the app renders. Drop
 * the extension here to get Arabic-Indic digits (٠١٢…) everywhere at once —
 * ICU plurals, Intl.DateTimeFormat and Intl.NumberFormat all read this map.
 *
 * **Hebrew needs no extension, and that is a decision, not an omission.** The
 * script has a numeral system of its own — `he-u-nu-hebr` renders 2026 as
 * «בתשפ״ו» — but CLDR's default numbering for `he` is already `latn`, and
 * Hebrew numerals are gematria: liturgical and calendrical, not what anyone
 * reads a clock or a count of tasks in. So Hebrew lands on the same Latin
 * digits Arabic was *forced* onto, for a different reason, and the two agree.
 * `__tests__/locale.test.ts` asserts the outcome rather than the spelling, so
 * a future `he-u-nu-hebr` here fails instead of shipping.
 */
export const INTL_LOCALE: Record<Locale, string> = {
  en: 'en',
  ar: 'ar-u-nu-latn',
  he: 'he',
};

/**
 * The locales written right to left.
 *
 * Direction is set once, on the root view (`src/Root.tsx`), so this is the only
 * place that decides it. Hebrew is RTL exactly as Arabic is; the two differ in
 * script and therefore in *font*, never in direction — which is why
 * `src/theme/fonts.ts` has a three-value `Script` and this has a two-value set.
 */
const RTL_LOCALES: readonly Locale[] = ['ar', 'he'];

/** Whether a locale reads right to left. */
export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

/**
 * The alphabet a locale's copy is written in, which is what picks the font.
 *
 * Separate from `isRtl` because the two questions have different answers:
 * Arabic and Hebrew agree on direction and disagree on every glyph. Collapsing
 * them into one boolean is exactly how the app arrived at a Hebrew locale it
 * could route, translate and format — and not draw.
 */
const LOCALE_SCRIPT: Record<Locale, Script> = {
  en: 'latin',
  ar: 'arabic',
  he: 'hebrew',
};

/** The script a locale is set in: 'latin' | 'arabic' | 'hebrew'. */
export function scriptFor(locale: Locale): Script {
  return LOCALE_SCRIPT[locale];
}

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
