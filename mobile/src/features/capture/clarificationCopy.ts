/**
 * Turning the server's question keys into words (UC-2.5, #165).
 *
 * The server sends `questionKey`, `params`, and per option `labelKey` and
 * `labelParams`. Nothing it sends is ever displayed: the words are the phone's,
 * so all three languages can be read and reviewed together and no model can
 * phrase a question that is applied to somebody's commitment.
 *
 * A key this build does not know returns null. The caller then falls back to
 * UC-2.4 (#164)'s edit sheet, which can express anything a fixed question
 * cannot — and never renders the key itself, which is an internal token.
 */
import { ltr } from '../../i18n/bidi';


/** The longest free-text answer the endpoint reads. Mirrors the contract. */
export const CLARIFICATION_FREE_TEXT_MAX = 200;

const QUESTION_KEY: Record<string, string> = {
  ask_time: 'clarifyAskTime',
  ask_action: 'clarifyAskAction',
  ask_am_pm: 'clarifyAskAmPm',
  ask_day: 'clarifyAskDay',
};

const OPTION_KEY: Record<string, string> = {
  morning: 'clarifyMorning',
  afternoon: 'clarifyAfternoon',
  evening: 'clarifyEvening',
  noTime: 'clarifyNoTime',
  today: 'clarifyToday',
  tomorrow: 'clarifyTomorrow',
};

/** The one option key whose words depend on a parameter (see PERIOD_KEY). */
const AM_PM_OPTION = 'amPmOption';

/**
 * `amPmOption` carries `period: 'am' | 'pm'` — a token, like a key, so it is
 * never substituted into the words (UAT r6, shot 582: «am 5» on an Arabic
 * chip). Each period has its own phone-owned string; one this build does not
 * know renders null and the chip is left out, because the hour alone would put
 * two identical «5» chips side by side that apply different times.
 */
const PERIOD_KEY: Record<string, string> = {
  am: 'clarifyAmPmOptionAm',
  pm: 'clarifyAmPmOptionPm',
};

/** Every question key this build can render. A test pins it against the contract. */
export const KNOWN_QUESTION_KEYS = Object.keys(QUESTION_KEY);
/** Every option label key this build can render. */
export const KNOWN_OPTION_KEYS = [...Object.keys(OPTION_KEY), AM_PM_OPTION];

function render(
  key: string | undefined,
  params: Record<string, string>,
  strings: Record<string, string>,
): string | null {
  const template = key ? strings[key] : undefined;
  if (!template) return null;
  let text = template;
  for (const [name, value] of Object.entries(params)) {
    text = text.split(`{${name}}`).join(value);
  }
  // A placeholder the server did not fill would put `{hour}` on the screen.
  return /\{[a-zA-Z]+\}/.test(text) ? null : text;
}

/** A server `date` parameter: a day key, never prose. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The question's words.
 *
 * `ask_time` may carry the day it is asking about (L4): "What time on Sunday,
 * 27 Sep?" instead of "What time works?", so a guessed Sunday is visible at
 * the moment the user is asked about it. The server sends a day key; the words
 * for it come from the formatter the caller passes, because only the caller
 * knows the language. Without it — or with a day key that is not one —
 * the plain question is asked, never a question with a hole in it.
 */
export function questionText(
  questionKey: string,
  params: Record<string, string>,
  strings: Record<string, string>,
  formatDayKey?: (dayKey: string) => string,
): string | null {
  const date = params.date;
  if (questionKey === 'ask_time' && date && DAY_KEY.test(date) && formatDayKey) {
    const withDate = render('clarifyAskTimeOn', { ...params, date: formatDayKey(date) }, strings);
    if (withDate) return withDate;
  }
  return render(QUESTION_KEY[questionKey], params, strings);
}

export function optionLabel(
  labelKey: string,
  labelParams: Record<string, string>,
  strings: Record<string, string>,
): string | null {
  if (labelKey === AM_PM_OPTION) {
    const { period, ...rest } = labelParams;
    const key = period && Object.prototype.hasOwnProperty.call(PERIOD_KEY, period) ? PERIOD_KEY[period] : undefined;
    return render(key, rest, strings);
  }
  return render(OPTION_KEY[labelKey], labelParams, strings);
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A real calendar date (`2030-02-30` is not one), as `YYYY-MM-DD`. */
function isRealDate(value: string): boolean {
  const match = LOCAL_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * A free time's words (M4a, WIRE-M4a): «بكرا 12:00» on the chip and «وقت
 * فاضي: بكرا الساعة 12:00» for a screen reader, the hour as one left-to-right
 * unit. `freeSlot`'s `labelParams` are values, not words, so the generic
 * substitution — which would print a raw date — is never used for it. A date
 * or an hour that does not parse returns null and the chip is left out.
 */
export function freeSlotWords(
  value: { localDate?: string | undefined; localTime?: string | undefined },
  relativeDay: (localDate: string) => string | null,
  strings: Record<string, string>,
): { label: string; a11y: string } | null {
  const { localDate, localTime } = value;
  if (!localDate || !localTime || !isRealDate(localDate) || !LOCAL_TIME.test(localTime)) return null;
  const day = relativeDay(localDate);
  if (!day) return null;
  const time = ltr(localTime);
  const label = render('clarifyFreeSlot', { day, time }, strings);
  const a11y = render('yFreeSlotA11y', { day, time }, strings);
  return label && a11y ? { label, a11y } : null;
}
