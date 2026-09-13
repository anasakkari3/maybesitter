/**
 * Why this step, in the user's own language (UC-2.R3 #173, UC-2.9 #170).
 *
 * ── The server used to answer in English ─────────────────────────
 *
 * `explanation.evidenceLabels` are English prose — "overdue", "due within 24
 * hours", "you often set these aside" — and `summary` is "Based on overdue."
 * The endpoint has always taken a `locale` and has never used it for either,
 * so an Arabic-first app showed its one explanatory line in English.
 *
 * The server now also sends `evidenceCodes`, and this renders them. Same rule
 * as the clarification questions in `captureContracts`: the server sends a key
 * and parameters, the phone owns the sentence. The copy then lives in
 * `locales/*.json`, where all three languages can be read and reviewed side by
 * side, instead of being assembled per request on a machine that cannot spell
 * them.
 *
 * ── An unknown code renders nothing ──────────────────────────────
 *
 * Not the code itself, and not the English label sitting next to it. A server
 * ahead of the app is a normal state during a staged rollout; a raw
 * `usual_productive_time` on someone's screen is not.
 */
import { fill } from '../../i18n/strings';

export interface EvidenceItem {
  code: string;
  /**
   * `| undefined` on each field, not just on `params`: the app compiles with
   * `exactOptionalPropertyTypes`, and the Zod-inferred shape this receives has
   * them that way.
   */
  params?: { level?: 'low' | 'normal' | 'high' | undefined; minutes?: number | undefined } | undefined;
}

const PHRASE_KEY: Record<string, string> = {
  overdue: 'evidenceOverdue',
  due_within_24h: 'evidenceDueWithin24h',
  due_within_7d: 'evidenceDueWithin7d',
  importance: 'evidenceImportance',
  importance_estimated: 'evidenceImportanceEstimated',
  fits_focus_time: 'evidenceFitsFocusTime',
  effort: 'evidenceEffort',
  outside_usual_hours: 'evidenceOutsideUsualHours',
  short_for_end_of_day: 'evidenceShortForEndOfDay',
  fits_before_due: 'evidenceFitsBeforeDue',
  usually_finishes: 'evidenceUsuallyFinishes',
  often_set_aside: 'evidenceOftenSetAside',
  usual_productive_time: 'evidenceUsualProductiveTime',
};

/** Must / Should / Nice — the same words the groups use, so they agree. */
const LEVEL_KEY: Record<'low' | 'normal' | 'high', string> = {
  high: 'todayGroupMust',
  normal: 'todayGroupShould',
  low: 'todayGroupNice',
};

/** One phrase, or null when this build has no words for that code. */
export function evidencePhrase(item: EvidenceItem, strings: Record<string, string>): string | null {
  const key = PHRASE_KEY[item.code];
  if (!key) return null;
  const phrase = strings[key];
  if (!phrase) return null;

  if (item.code === 'importance' || item.code === 'importance_estimated') {
    const level = item.params?.level;
    if (!level) return null;
    const word = strings[LEVEL_KEY[level]];
    return word ? fill(phrase, { level: word }) : null;
  }
  if (item.code === 'effort') {
    const minutes = item.params?.minutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return null;
    return fill(phrase, { minutes: String(Math.round(minutes)) });
  }
  return phrase;
}

/** Every phrase this build can say, unknown codes dropped, order preserved. */
export function evidencePhrases(
  items: readonly EvidenceItem[],
  strings: Record<string, string>,
): string[] {
  return items
    .map((item) => evidencePhrase(item, strings))
    .filter((phrase): phrase is string => phrase !== null);
}

/** The codes this build has copy for. A test asserts it matches the server's list. */
export const KNOWN_EVIDENCE_CODES = Object.keys(PHRASE_KEY);
