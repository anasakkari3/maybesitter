/**
 * The proposal's shape, settled after every item has been read (audit
 * 2026-10-03 #1 and #6).
 *
 * «I want to learn React and study on Tuesday and Thursday evenings at 7 PM»
 * came back, on production, as «تتعلم React» and two «تدرس» — all three on
 * Tuesday at 19:00 — and could be saved like that. The model's list varies
 * from run to run, so what holds the line is here, after it, and none of it
 * asks the model anything:
 *
 *   occurrences   an item at one hour whose own words name several weekdays
 *                 ("Tuesday and Thursday", "every Tuesday and Thursday") is
 *                 one item on each of those days — never two on one day.
 *   duplicates    two items with the same title at the same time are one.
 *   the goal      "learn React" beside the sessions that carry it out is the
 *                 goal, not one more timed thing at the session's hour: it
 *                 leaves the timed list. When the person already has that
 *                 goal, the sessions offer to count toward it (`goalLink`);
 *                 when they do not, it is offered as a «possible goal» seed,
 *                 which the person may keep and turn into a goal.
 *
 * Pure: the clock, the zone and the person's goals are arguments. Nothing here
 * logs, and nothing here is saved — a goal link is a suggestion on the card
 * until the person confirms with it kept.
 */
import type { CaptureGoalLinkSuggestionContract, CaptureProposalItemContract } from '../../../src/contracts/v1/captureContracts';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { instantFromLocal, localTimeSpecFor, statedClockHours } from '../../../src/extraction/timeLexicon';
import { readListedWeekdays, readRecurrence, resolveWeekdayDates } from '../../../src/extraction/weekdayLexicon';
import { contentWords, sameWord } from './chatEvidence';

/** An active goal of the person's, as the capture is shown it: its id and its own words. */
export interface ActiveGoal {
  readonly goalId: string;
  readonly title: string;
}

/*
 * Words that span the days rather than list them: "between Tuesday and
 * Thursday", "from Tuesday to Thursday", «بين الثلاثاء والخميس», «من الثلاثاء
 * لـ الخميس», «עד יום חמישי». A deadline or a range is one thing, not two.
 */
const DAY_WORD_EN = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const DAY_WORD_AR = '(?:ال)?(?:أحد|احد|اثنين|إثنين|ثلاثاء|ثلثاء|أربعاء|اربعاء|خميس|جمعة|جمعه|سبت)';
const DAY_WORD_HE = '(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)';
const SPANNING = new RegExp([
  `\\b(?:between|from|until|till|through|thru|to)\\s+(?:on\\s+)?(?:next\\s+)?${DAY_WORD_EN}\\b`,
  `(?:^|[^\\p{L}])(?:بين|من|لحد|لغاية|للغاية|حتى|لـ)\\s*(?:يوم\\s+)?${DAY_WORD_AR}`,
  `(?:^|[^\\p{L}])(?:בין|עד|מ)\\s*(?:ה?יום\\s+)?${DAY_WORD_HE}`,
  '\\bor\\b|(?:^|\\s)(?:أو|او|ولا|או)(?:\\s|$)',
].join('|'), 'iu');

/** The local date of an instant, on the person's clock. */
function localDateOf(instant: string | null | undefined, timezone: string): string | null {
  if (!instant) return null;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? localTimeSpecFor(new Date(parsed), timezone)?.date ?? null : null;
}

function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The days one item happens on, when its words name more than one: the
 * coming occurrence of each weekday they list, the item's own day among them.
 * Null for anything else — one day, a range of days, an item with no settled
 * hour, an all-day item, or words that state more than one hour (each day may
 * then have its own, and that is the model's and the clarifier's to read).
 */
export function occurrenceDatesFor(result: ExtractionResult, words: string, now: Date, timezone: string): string[] | null {
  if (result.allDay || !(result.dueAt || result.remindAt) || !words.trim()) return null;
  const date = result.localTimeSpec?.date ?? localDateOf(result.remindAt ?? result.dueAt, timezone);
  if (!date) return null;
  const recurrence = readRecurrence(words);
  const listed = recurrence && recurrence.weekdays.length > 1 ? recurrence.weekdays : readListedWeekdays(words);
  if (listed.length < 2) return null;
  if (!recurrence && SPANNING.test(words)) return null;
  // One hour for all of them, and the item's: "Tuesday at 4 and Thursday at
  // 6" is two hours, each its own day's.
  const hours = statedClockHours(words);
  const time = result.localTimeSpec?.time ?? localTimeSpecFor(new Date(Date.parse((result.remindAt ?? result.dueAt)!)), timezone)?.time ?? null;
  if (hours.size > 1 || (hours.size === 1 && (!time || !hours.has(Number(time.slice(0, 2)) % 12)))) return null;
  const dates = resolveWeekdayDates(words, now, timezone);
  const wanted = new Set(listed);
  const onDays = dates.filter((candidate) => wanted.has(weekdayOf(candidate)));
  // The item must already be on one of them: a day the words do not list is
  // not ours to fan out from.
  if (onDays.length < 2 || !onDays.includes(date)) return null;
  return Array.from(new Set(onDays)).sort();
}

/**
 * The same reading on another day, at the same hour on the person's clock.
 * A recurrence hint narrows to that day: two items each offering a block on
 * Tuesday *and* Thursday would be two blocks on each day.
 */
export function onDate(result: ExtractionResult, date: string, timezone: string): ExtractionResult {
  const time = result.localTimeSpec?.time ?? localTimeSpecFor(new Date(Date.parse((result.remindAt ?? result.dueAt)!)), timezone)?.time ?? null;
  const instant = time ? instantFromLocal(date, time, timezone)?.toISOString() ?? null : null;
  const weekday = weekdayOf(date);
  return {
    ...result,
    dueAt: result.dueAt ? instant : null,
    remindAt: result.remindAt ? instant : null,
    localTimeSpec: { date, time, timezone },
    ...(result.recurrenceHint ? { recurrenceHint: { ...result.recurrenceHint, weekdays: [weekday] } } : {}),
  };
}

/** A title as two near-identical ones meet: folded words, in order, without the recurrence or the possession lead-in. */
export function titleKey(title: string): string {
  return contentWords(title).join(' ');
}

/**
 * Item ids that repeat an earlier item: the same title (folded, in the card's
 * words or the person's) at the same instant. The first one said stays. Only
 * timed items: two untimed asks of the same thing (one per shared email) are
 * the share's to tell apart, and each still asks its own question.
 */
export function duplicateItemIds(
  items: readonly CaptureProposalItemContract[],
  sourceTitles: ReadonlyMap<string, string>,
): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (!item.resolvedTime || item.needsClarification) continue;
    const keys = [titleKey(item.title), titleKey(sourceTitles.get(item.itemId) ?? '')].filter(Boolean);
    const slot = Date.parse(item.resolvedTime);
    if (keys.length > 0 && keys.some((key) => seen.has(`${slot}|${key}`))) {
      duplicates.add(item.itemId);
      continue;
    }
    for (const key of keys) seen.add(`${slot}|${key}`);
  }
  return duplicates;
}

/*
 * A title that is a goal rather than a session of it: learning, mastering,
 * getting better at something. Read on the person's words and on the card's,
 * at the start of the title, in the three languages. «تدرس»/"study" is the
 * session and is not here; «ללמוד» is both in Hebrew and counts only with
 * something after it ("ללמוד React").
 */
const GOAL_OPENERS: readonly RegExp[] = [
  new RegExp("^(?:i\\s+)?(?:(?:want|need|would\\s+like|'d\\s+like|plan|hope)\\s+to\\s+|wanna\\s+)?(?:learn|master|get\\s+better\\s+at|improve\\s+(?:my\\s+)?|become\\s+(?:a|an)\\b|start\\s+learning)\\b", 'i'),
  new RegExp('^(?:بدي|بدّي|حابب|حابة|ناوي|ناوية)?\\s*(?:أ|ا|ت|ي|ن)?(?:تعلّم|تعلم|تقن|حسّن)(?:وا|ي)?(?:\\s|$)', 'u'),
  new RegExp('^(?:(?:אני\\s+)?(?:רוצה|צריך|צריכה)\\s+)?(?:ללמוד|לשפר|להשתפר\\s+ב|לשלוט\\s+ב)\\s*\\S', 'u'),
];

/** Whether an item's title (either one) is the goal its sessions serve. */
export function isGoalTitle(...titles: readonly (string | undefined)[]): boolean {
  return titles.some((title) => typeof title === 'string' && GOAL_OPENERS.some((pattern) => pattern.test(title.trim())));
}

/** The words of a goal that say what it is about — not "learn", «أتعلم», «ללמוד». */
const GOAL_VERB_WORDS = new Set(contentWords(
  'learn learning master improve better become study studying practice practise start want would like tutorial course '
  + 'تعلم أتعلم اتعلم تتعلم يتعلم نتعلم تعلّم أدرس ادرس تدرس دراسة دراسه حسّن أحسّن اتقن أتقن تمرين بدي '
  + 'ללמוד לומד לומדת לשפר להשתפר לתרגל רוצה',
));

function goalKeyWords(text: string): string[] {
  return contentWords(text).filter((word) => !Array.from(GOAL_VERB_WORDS).some((verb) => sameWord(verb, word)));
}

/**
 * The one active goal these words are about, or null: it shares a word that
 * says what the goal is (React, guitar, «الإنجليزي») with them, and no other
 * goal shares as many. A tie, or a match only on "learn", is no match: a goal
 * link the person did not mean is worse than none.
 */
export function matchingGoal(words: string, goals: readonly ActiveGoal[]): ActiveGoal | null {
  const said = contentWords(words);
  if (said.length === 0) return null;
  const scored = goals.map((goal) => ({
    goal,
    score: Array.from(new Set(goalKeyWords(goal.title))).filter((word) => said.some((candidate) => sameWord(word, candidate))).length,
  }));
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  if (best === 0) return null;
  const top = scored.filter((entry) => entry.score === best);
  return top.length === 1 ? top[0]!.goal : null;
}

export function goalLinkFor(goal: ActiveGoal): CaptureGoalLinkSuggestionContract {
  return { goalId: goal.goalId, title: goal.title };
}
