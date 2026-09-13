/**
 * Which locale the recogniser should be asked for (UC-2.3, #163).
 *
 * Pure, and separate from the recogniser itself, because the traps here are all
 * in the matching rather than in the speech API:
 *
 * -- Hebrew is `iw` on Android -----------------------------------
 *
 * `iw` is the pre-1989 ISO 639 code for Hebrew, and the JDK froze it for
 * backwards compatibility -- so Android's locale list reports Hebrew as `iw-IL`
 * while iOS reports `he-IL`. An app that asks for `he-IL` on Android is told the
 * language is unsupported, on a device that supports it perfectly well.
 *
 * So matching is done on a normalized form, and the **platform's own string** is
 * what gets returned. Normalizing the returned value would hand `he-IL` back to
 * Android, which is the same bug from the other end.
 *
 * -- Arabic has no single right region ---------------------------
 *
 * The product's users write Levantine. `ar-SA` recognises Modern Standard Arabic
 * far better than it recognises «بكرا», so the Levantine regions come first and
 * the Gulf ones after -- and any `ar-*` is still better than refusing to listen.
 *
 * -- On-device is preferred, within the order --------------------
 *
 * Not above it. A worse-matched locale that happens to be installed would
 * transcribe the wrong dialect locally, which is not a privacy win -- it is a
 * transcription nobody can use. So the region order decides first, and on-device
 * breaks ties within it.
 */

export type SpeechLanguage = 'ar' | 'he' | 'en';

export type SpeechLocaleResolution =
  | { kind: 'supported'; localeId: string; onDevice: boolean }
  | { kind: 'unsupported'; language: SpeechLanguage };

/**
 * Preference order per language, most-wanted first.
 *
 * Arabic leads with the Levantine regions because that is what this product's
 * users speak; `ar-SA` is Modern Standard and mishears dialect.
 */
const PREFERRED: Record<SpeechLanguage, readonly string[]> = {
  ar: ['ar-PS', 'ar-JO', 'ar-IL', 'ar-LB', 'ar-SY', 'ar-SA', 'ar-AE'],
  // Both spellings, in this order: `he-IL` is correct and modern, `iw-IL` is
  // what Android actually reports.
  he: ['he-IL', 'iw-IL'],
  en: ['en-US', 'en-GB'],
};

/**
 * The form two locale ids are compared in.
 *
 * Underscores become hyphens (Android writes `ar_JO`), case is folded, and `iw`
 * becomes `he` so the two spellings of Hebrew compare equal. Used for matching
 * only -- never returned.
 */
export function normalizeLocaleId(value: string): string {
  const normalized = value.trim().replace(/_/g, '-').toLowerCase();
  const [language, ...rest] = normalized.split('-');
  // `iw` and `ji` are the frozen legacy codes for Hebrew and Yiddish; only the
  // first matters here, but normalizing it is what makes the two platforms agree.
  const canonical = language === 'iw' ? 'he' : language;
  return [canonical, ...rest].join('-');
}

/** The language part of a locale id, normalized. */
function languageOf(value: string): string {
  return normalizeLocaleId(value).split('-')[0] ?? '';
}

/**
 * Picks the locale to ask for, or reports that the language is unsupported.
 *
 * `available` and `onDevice` are the platform's own lists, passed in rather than
 * fetched, so this stays testable without a device and without the speech module.
 */
export function resolveSpeechLocale(
  language: SpeechLanguage,
  available: readonly string[],
  onDevice: readonly string[] = [],
): SpeechLocaleResolution {
  const installed = new Set(onDevice.map(normalizeLocaleId));
  // The platform's original string, keyed by its normalized form. First wins, so
  // a platform listing both `he-IL` and `iw-IL` keeps whichever it named first.
  const byNormalized = new Map<string, string>();
  for (const id of available) {
    const key = normalizeLocaleId(id);
    if (!byNormalized.has(key)) byNormalized.set(key, id);
  }

  const ordered: string[] = [];
  for (const preferred of PREFERRED[language]) {
    const key = normalizeLocaleId(preferred);
    if (byNormalized.has(key) && !ordered.includes(key)) ordered.push(key);
  }
  // Then any other region of the same language, in the order the platform listed
  // them: a locale we did not think of is still better than refusing to listen.
  for (const key of byNormalized.keys()) {
    if (languageOf(key) === language && !ordered.includes(key)) ordered.push(key);
  }

  if (ordered.length === 0) return { kind: 'unsupported', language };

  // On-device breaks ties *within* the order, never above it: a worse-matched
  // locale that happens to be installed transcribes the wrong dialect locally,
  // which is a transcription nobody can use.
  const best = ordered.find((key) => installed.has(key)) ?? ordered[0]!;
  return {
    kind: 'supported',
    localeId: byNormalized.get(best)!,
    onDevice: installed.has(best),
  };
}

/**
 * The app language a speech locale should be requested for.
 *
 * The app displays only English and Arabic (`SELECTABLE_LOCALES`), but it reads
 * and captures Hebrew, so the speech language is resolved from the device tag
 * rather than from what the UI is rendered in. Someone whose phone is Hebrew
 * should be able to dictate Hebrew into an English-looking app.
 */
export function speechLanguageForTag(tag: string | null | undefined): SpeechLanguage {
  const language = languageOf(tag ?? '');
  if (language === 'ar') return 'ar';
  if (language === 'he') return 'he';
  return 'en';
}
