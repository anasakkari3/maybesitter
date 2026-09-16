/**
 * The sentence a kept suggestion is stored as (UC-3.16, #202).
 *
 * A suggestion travels to the phone as a token and a window, and the phone
 * words it — the same split `sourceLabel` makes. Keep is different: it writes a
 * memory record, and a record's `content` is a sentence in a language, read
 * back by every surface that lists memory. So the sentence is fixed here, on
 * the server, from the rule's own window and never from the request body — a
 * client that could choose the words could store any claim it liked under
 * `source: 'deterministic_rule'`.
 *
 * Plain and descriptive: what happened, in the user's clock. No claim to know
 * the person (§13), no judgement, and nothing about what it will be used for —
 * the screen says that, separately, next to the Delete that undoes it.
 */
import type { LocalWindow } from './rules';

export type KeptSuggestionLanguage = 'en' | 'ar' | 'he';

export const KEPT_SUGGESTION_LANGUAGES: readonly KeptSuggestionLanguage[] = ['en', 'ar', 'he'];

export const KEPT_SUGGESTION_CONTENT: Readonly<Record<KeptSuggestionLanguage, string>> = Object.freeze({
  en: 'You often finish things between {start} and {end}.',
  ar: 'غالباً بتخلّص أشغالك بين {start} و{end}.',
  he: 'לרוב דברים מסתיימים אצלך בין {start} ל-{end}.',
});

export function keptFocusWindowContent(window: LocalWindow, language: KeptSuggestionLanguage): string {
  return KEPT_SUGGESTION_CONTENT[language].replace('{start}', window.start).replace('{end}', window.end);
}
