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

/**
 * R2's kept sentence (UC-3.14, #532). `{duration}` is filled by
 * `deferDurationText`, not by anything the request sends, for the same reason
 * the whole sentence is fixed here.
 */
export const KEPT_DEFER_CONTENT: Readonly<Record<KeptSuggestionLanguage, string>> = Object.freeze({
  en: 'When you push something later, it’s usually by {duration}.',
  ar: 'لمّا بتأجّل إشي لبعدين، غالباً بتأجّله {duration}.',
  he: 'כשאתה דוחה משהו לאחר כך, הדחייה היא בדרך כלל של {duration}.',
});

export function keptDeferDefaultContent(deferMinutes: number, language: KeptSuggestionLanguage): string {
  return KEPT_DEFER_CONTENT[language].replace('{duration}', deferDurationText(deferMinutes, language));
}

/**
 * R3's kept sentence (#533). `{time}` is the rule's own half-hour, never the
 * request body's, for the same reason the whole sentence is fixed here.
 */
export const KEPT_PLAN_TIME_CONTENT: Readonly<Record<KeptSuggestionLanguage, string>> = Object.freeze({
  en: 'You usually look at your plan around {time}.',
  ar: 'غالباً بتفتح خطتك حوالي {time}.',
  he: 'לרוב אתה מסתכל על התוכנית שלך בסביבות {time}.',
});

export function keptPlanTimeContent(planTime: string, language: KeptSuggestionLanguage): string {
  return KEPT_PLAN_TIME_CONTENT[language].replace('{time}', planTime);
}

/**
 * A duration as a person says it, in the kept sentence's own language.
 *
 * The buckets a rule can produce are half-hour multiples, so the forms below
 * cover exactly those: under an hour there is only the half hour, and past
 * two hours the count takes over. Anything else — a duration this version
 * never bucketed — falls back to bare minutes rather than a sentence nobody
 * worded.
 */
export function deferDurationText(minutes: number, language: KeptSuggestionLanguage): string {
  if (minutes === 30) {
    return { en: '30 minutes', ar: 'نص ساعة', he: 'חצי שעה' }[language];
  }
  if (minutes < 60 || minutes % 30 !== 0) {
    return { en: `${minutes} minutes`, ar: `${minutes} دقيقة`, he: `${minutes} דקות` }[language];
  }
  const whole = Math.floor(minutes / 60);
  const half = minutes % 60 === 30;
  if (language === 'en') {
    if (whole === 1) return half ? '1.5 hours' : '1 hour';
    if (whole === 2) return half ? '2.5 hours' : '2 hours';
    return `${whole}${half ? '.5' : ''} hours`;
  }
  if (language === 'ar') {
    if (whole === 1) return half ? 'ساعة ونص' : 'ساعة';
    if (whole === 2) return half ? 'ساعتين ونص' : 'ساعتين';
    return `${whole} ساعات${half ? ' ونص' : ''}`;
  }
  if (whole === 1) return half ? 'שעה וחצי' : 'שעה';
  if (whole === 2) return half ? 'שעתיים וחצי' : 'שעתיים';
  return `${whole} שעות${half ? ' וחצי' : ''}`;
}
