import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { DEFAULT_LOCALE, SELECTABLE_LOCALES, apiLocale } from './locale';

export const LANGUAGE_STORAGE_KEY = 'settings.language';

/** The locales a user can actually choose: 'en' | 'ar'. */
export type SelectableLocale = (typeof SELECTABLE_LOCALES)[number];

/**
 * What the picker offers, in order: System, English, العربية. Hebrew is not
 * here on purpose — see SELECTABLE_LOCALES in locale.ts and README.md.
 */
export const LANGUAGE_OPTIONS = ['system', ...SELECTABLE_LOCALES] as const;
export type LanguagePref = (typeof LANGUAGE_OPTIONS)[number];

/** A language is named in itself, never translated. */
export const LANGUAGE_ENDONYM: Record<SelectableLocale, string> = {
  en: 'English',
  ar: 'العربية',
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
 * device and falls back to English when the device language is not offered —
 * including Hebrew, which the app has copy for but cannot yet display.
 */
export function resolveLanguage(
  pref: LanguagePref,
  tag: string | null | undefined = systemLanguageTag(),
): SelectableLocale {
  if (pref !== 'system') return pref;
  const locale = apiLocale(tag);
  return (SELECTABLE_LOCALES as readonly string[]).includes(locale) ? (locale as SelectableLocale) : DEFAULT_LOCALE;
}

/** System → English → العربية → System. */
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
