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
  amPmOption: 'clarifyAmPmOption',
};

/** Every question key this build can render. A test pins it against the contract. */
export const KNOWN_QUESTION_KEYS = Object.keys(QUESTION_KEY);
/** Every option label key this build can render. */
export const KNOWN_OPTION_KEYS = Object.keys(OPTION_KEY);

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

export function questionText(
  questionKey: string,
  params: Record<string, string>,
  strings: Record<string, string>,
): string | null {
  return render(QUESTION_KEY[questionKey], params, strings);
}

export function optionLabel(
  labelKey: string,
  labelParams: Record<string, string>,
  strings: Record<string, string>,
): string | null {
  return render(OPTION_KEY[labelKey], labelParams, strings);
}
