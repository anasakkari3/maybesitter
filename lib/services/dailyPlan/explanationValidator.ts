/**
 * What the day's explanation is allowed to say (UC-3.10a, #194).
 *
 * A model writes two or three sentences about a plan a deterministic scheduler
 * produced. The scheduler is the authority on the plan; the model is only
 * allowed to narrate it. So every claim the sentence can make that is checkable
 * against the plan *is* checked, and a sentence that fails any check is thrown
 * away and replaced by the template — never patched, never partially used.
 *
 * Deterministic: no clock, no randomness, no network, no model. The same text
 * and the same facts always give the same verdict, which is what makes the
 * three acceptance tests (an invented time, an invented title, a §13 phrase)
 * assertions rather than samples.
 *
 * ── What the checks can and cannot reach ─────────────────────────
 *
 * The structural checks — clock times, titles, counts, length — are
 * language-independent and hold for Arabic, Hebrew and English alike. The
 * lexical ones are not: `SHAME_PATTERNS`, `COERCION_PATTERNS` and
 * `PERSISTENCE_CLAIM_PATTERNS` are English, and the §13 list below is the
 * English wording of the strategy document. An Arabic sentence that shames is
 * not caught by a word list here, and saying otherwise would be worse than the
 * gap: what catches it is that the prompt is given item ids, times and counts
 * and nothing else to be judgemental *about*, plus the structural checks, plus
 * a human reading the fallback rate.
 *
 * Numbers and clock times are read as ASCII. A model answering in Arabic-Indic
 * numerals fails the count check and falls back to the template. That is the
 * conservative direction — the template is always true — and it is a known
 * limitation rather than an oversight.
 */
import type { Plan } from '../../../src/contracts/v1/planningContracts';
import type { UserLocale } from '../../storage/userDocument';
import {
  COERCION_PATTERNS,
  PERSISTENCE_CLAIM_PATTERNS,
  SHAME_PATTERNS,
  matchesAny,
} from '../../safety/lexicon';
import { toEpochMs, wallClockAt } from '../../planning/shared/time';

/** The issue's cap. Three calm sentences fit inside it; a paragraph does not. */
export const MAX_EXPLANATION_CHARS = 400;

/**
 * `docs/strategy/CURRENT_PRODUCT_STRATEGY.md` §13, as patterns.
 *
 * Encoded here rather than parsed from the document: a test that read the
 * markdown would pass on a document whose list had been emptied. The bullet
 * about "any medical, therapeutic, autonomous, or comprehensive-memory promise"
 * is a rule for people, not a regex, so what stands in for it is the narrower
 * set of phrasings a model actually produces for it.
 */
export const PROHIBITED_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bmanages?\s+your\s+(entire\s+)?life\b/i,
  /\bknows?\s+you\s+better\s+than\s+you\s+know\s+yourself\b/i,
  /\btreats?\s+adhd\b/i,
  /\breplaces?\s+your\s+judg(e)?ment\b/i,
  /\bautomatically\s+understands?\s+every\b/i,
  /\bi\s+remember\s+everything\b/i,
  /\b(diagnos|therap|prescrib)(e|es|ing|y|eutic)\b/i,
]);

export type ExplanationRejection =
  | 'empty'
  | 'too_long'
  | 'time_not_in_plan'
  | 'unknown_title'
  | 'count_mismatch'
  | 'shame'
  | 'coercion'
  | 'persistence_claim'
  | 'prohibited_claim';

/** Everything about a plan the explanation is allowed to refer to. */
export interface ExplanationFacts {
  readonly locale: UserLocale;
  /** Every start and end of a placed interval, local `HH:mm`. */
  readonly allowedTimes: readonly string[];
  /** The titles of the items that were placed. */
  readonly titles: readonly string[];
  readonly scheduledCount: number;
  readonly unscheduledCount: number;
  /** The first start and last end, for the template. Null when nothing fits. */
  readonly firstStart: string | null;
  readonly lastEnd: string | null;
}

function hhmm(instant: string, timezone: string): string {
  const parts = wallClockAt(toEpochMs(instant), timezone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/**
 * What a plan permits an explanation to say.
 *
 * Titles come from the caller's map rather than from the plan, because a `Plan`
 * carries `itemId`s and no text at all — which is deliberate, and is why the
 * digest can be logged while the titles cannot.
 */
export function explanationFactsFrom(
  plan: Plan,
  titles: ReadonlyMap<string, string>,
  timezone: string,
  locale: UserLocale,
): ExplanationFacts {
  const ordered = [...plan.scheduled].sort((left, right) => toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt));
  const allowed = new Set<string>();
  for (const placed of ordered) {
    allowed.add(hhmm(placed.interval.startsAt, timezone));
    allowed.add(hhmm(placed.interval.endsAt, timezone));
  }
  const last = ordered.reduce<string | null>(
    (latest, placed) => (latest === null || toEpochMs(placed.interval.endsAt) > toEpochMs(latest) ? placed.interval.endsAt : latest),
    null,
  );
  return {
    locale,
    allowedTimes: Array.from(allowed),
    titles: ordered.map((placed) => titles.get(placed.itemId) ?? '').filter((title) => title !== ''),
    scheduledCount: plan.scheduled.length,
    unscheduledCount: plan.unscheduled.length,
    firstStart: ordered.length > 0 ? hhmm(ordered[0].interval.startsAt, timezone) : null,
    lastEnd: last === null ? null : hhmm(last, timezone),
  };
}

const CLOCK = /\b([01]?[0-9]|2[0-3]):([0-5][0-9])\b/g;
const QUOTED = /["“”«»']([^"“”«»'\n]{2,80})["“”«»']/g;
/** Two or more adjacent Capitalised Latin words: the shape an invented title takes. */
const CAPITALISED_RUN = /\b[A-Z][a-z'’]+(?:\s+[A-Z][a-z'’]+)+/g;
const INTEGER = /\b\d{1,4}\b/g;

function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s‏‎]+/g, ' ').trim();
}

/** True when the fragment is part of some title the plan actually placed. */
function matchesSomeTitle(fragment: string, titles: readonly string[]): boolean {
  const needle = normalise(fragment);
  if (needle.length < 2) return true;
  return titles.some((title) => {
    const hay = normalise(title);
    return hay.includes(needle) || needle.includes(hay);
  });
}

/**
 * Every reason this text may not be shown, in a stable order.
 *
 * All of them, not the first: a caller that logs the rejection wants to know
 * the sentence both invented a time *and* shamed, and a validator that stopped
 * at the first would make the second invisible forever.
 */
export function explanationRejections(text: unknown, facts: ExplanationFacts): ExplanationRejection[] {
  const reasons: ExplanationRejection[] = [];
  if (typeof text !== 'string' || text.trim() === '') return ['empty'];
  if (text.length > MAX_EXPLANATION_CHARS) reasons.push('too_long');

  const allowed = new Set(facts.allowedTimes);
  const times = Array.from(text.matchAll(CLOCK), (match) => `${match[1].padStart(2, '0')}:${match[2]}`);
  if (times.some((time) => !allowed.has(time))) reasons.push('time_not_in_plan');

  const quoted = Array.from(text.matchAll(QUOTED), (match) => match[1]);
  // A capitalised run that opens the text or a sentence is ordinary English
  // ("Today Nothing…"), so only runs that start mid-sentence are treated as a
  // claimed title.
  const capitalised = Array.from(text.matchAll(CAPITALISED_RUN))
    .filter((match) => {
      const before = text.slice(0, match.index ?? 0);
      return before.trim() !== '' && !/[.!?\n]\s*$/.test(before);
    })
    .map((match) => match[0]);
  if ([...quoted, ...capitalised].some((fragment) => !matchesSomeTitle(fragment, facts.titles))) {
    reasons.push('unknown_title');
  }

  // Clock times and quoted titles are removed first: `09:00` is not a claim
  // about how many things there are, and a title may legitimately contain a
  // number ("Pay the 2 invoices").
  const countable = text.replace(CLOCK, ' ').replace(QUOTED, ' ');
  const numbers = Array.from(countable.matchAll(INTEGER), (match) => Number(match[0]));
  if (numbers.some((value) => value !== facts.scheduledCount && value !== facts.unscheduledCount)) {
    reasons.push('count_mismatch');
  }

  if (matchesAny(text, SHAME_PATTERNS)) reasons.push('shame');
  if (matchesAny(text, COERCION_PATTERNS)) reasons.push('coercion');
  if (matchesAny(text, PERSISTENCE_CLAIM_PATTERNS)) reasons.push('persistence_claim');
  if (matchesAny(text, PROHIBITED_CLAIM_PATTERNS)) reasons.push('prohibited_claim');

  return reasons;
}

export function isValidExplanation(text: unknown, facts: ExplanationFacts): boolean {
  return explanationRejections(text, facts).length === 0;
}

/**
 * The sentence that is always true, in the user's language.
 *
 * Every number and every time in it comes from the plan, so it passes the
 * validator above by construction — which `tests/dailyPlan/explanationValidator.test.ts`
 * asserts for all three locales rather than assuming.
 *
 * Levantine Arabic and plain Hebrew, not formal register: this is the sentence a
 * person reads first thing in the morning.
 */
export function templateExplanation(facts: ExplanationFacts): string {
  const { scheduledCount: placed, unscheduledCount: left, firstStart, lastEnd, locale } = facts;
  const span = firstStart !== null && lastEnd !== null;

  if (locale === 'ar') {
    const head = span
      ? `حطيت ${placed} إشيا بين ${firstStart} و${lastEnd}.`
      : `ما في إشي بيزبط بأوقاتك اليوم.`;
    return left === 0 ? head : `${head} ${left} ما لحقوا اليوم وضلوا عندك بالقائمة.`;
  }
  if (locale === 'he') {
    const head = span
      ? `שיבצתי ${placed} דברים בין ${firstStart} ל-${lastEnd}.`
      : `שום דבר לא נכנס לחלונות של היום.`;
    return left === 0 ? head : `${head} ${left} לא נכנסו היום ונשארים ברשימה שלך.`;
  }
  const head = span
    ? `I placed ${placed} things between ${firstStart} and ${lastEnd}.`
    : `Nothing fits inside today's windows.`;
  return left === 0 ? head : `${head} ${left} did not fit today and stay on your list.`;
}
