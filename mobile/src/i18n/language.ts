import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { DEFAULT_LOCALE, SELECTABLE_LOCALES, apiLocale } from './locale';

export const LANGUAGE_STORAGE_KEY = 'settings.language';

/** The locales a user can actually choose: 'en' | 'ar' | 'he'. */
export type SelectableLocale = (typeof SELECTABLE_LOCALES)[number];

/**
 * What the picker offers, in order: System, English, العربية, עברית.
 *
 * Hebrew is last rather than beside Arabic because the order is the order the
 * row cycles through, and the two languages the product was designed in should
 * not be separated by a third that is still machine translated.
 */
export const LANGUAGE_OPTIONS = ['system', ...SELECTABLE_LOCALES] as const;
export type LanguagePref = (typeof LANGUAGE_OPTIONS)[number];

/** A language is named in itself, never translated. */
export const LANGUAGE_ENDONYM: Record<SelectableLocale, string> = {
  en: 'English',
  ar: 'العربية',
  // Not "Hebrew", and not «עִבְרִית» with points: the unpointed spelling is how
  // the language names itself in a menu, and it matches VoiceLanguageChip's.
  he: 'עברית',
};

export function isLanguagePref(value: unknown): value is LanguagePref {
  return typeof value === 'string' && (LANGUAGE_OPTIONS as readonly string[]).includes(value);
}

/** The device's preferred language tag, e.g. 'ar-IL'. Null if unreadable. */
export function systemLanguageTag(): string | null {
  try {
    return getLocales()[0]?.languageTag ?? null;
  } catch {
    return null;
  }
}

/**
 * Turns a stored preference into the language to render. 'system' follows the
 * device and falls back to English when the device language is not offered.
 *
 * A Hebrew phone now lands on Hebrew rather than on English. That is the whole
 * user-visible point of UC-2.R5: `apiLocale` has always resolved `he-IL` and
 * the Android-only `iw-IL` to `'he'`, and this line is where that answer used
 * to be thrown away.
 */
export function resolveLanguage(
  pref: LanguagePref,
  tag: string | null | undefined = systemLanguageTag(),
): SelectableLocale {
  if (pref !== 'system') return pref;
  const locale = apiLocale(tag);
  return (SELECTABLE_LOCALES as readonly string[]).includes(locale) ? (locale as SelectableLocale) : DEFAULT_LOCALE;
}

/** System → English → العربية → עברית → System. */
export function nextLanguagePref(pref: LanguagePref): LanguagePref {
  const i = LANGUAGE_OPTIONS.indexOf(pref);
  return LANGUAGE_OPTIONS[(i + 1) % LANGUAGE_OPTIONS.length] ?? 'system';
}

export async function loadLanguagePref(): Promise<LanguagePref> {
  try {
    const stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePref(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export async function saveLanguagePref(pref: LanguagePref): Promise<void> {
  try {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, pref);
  } catch {
    // A preference that fails to persist must not break switching language now.
  }
}
