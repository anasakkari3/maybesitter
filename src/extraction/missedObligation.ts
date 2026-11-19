/**
 * A thing the speaker was to do and did not (QA v3, V3-F04-03; owner decision
 * 2026-11-19), read deterministically and kept apart on purpose: it is one
 * narrow reading that can be removed whole — this module, its import in
 * `extractionService` and `chatEvidence`, and
 * tests/extraction/qaV3MissedObligation.test.ts — leaving the model and the
 * ordinary reading to read such sentences.
 */
import { stripTimeExpressions } from './ruleBasedExtractor';
import { localTimeSpecFor, relativeDayOffset } from './timeLexicon';
import { namesCalendarDate, readRecurrence, readWeekdayReference } from './weekdayLexicon';
import type { ExtractionContext, ExtractionResult } from './extractionTypes';

/*
 * ══ A THING THAT WAS TO BE DONE, AND WAS NOT (QA v3, V3-F04-03) ══
 *
 * «مبارح الساعة 9 الصبح كان لازم أبعت الواجب للدكتور وما بعتته» made
 * nothing: the model answered «بقدر أساعدك بالمهام الجاية», the rules put it
 * at 09:00 today. Owner decision (2026-11-19): it is a thing to do *now* — on
 * today's list, ready to be done. Nothing calls it late or missed (mobile
 * AGENTS.md: there is no "overdue"), its passed hour is not kept, and the
 * person is asked when today, as for any task with no hour; nothing is saved
 * until they confirm.
 *
 * What it is, and only that — one narrow pattern, the defect's own (review
 * of #872, rounds 2 and 3; coordinator decision 2026-11-19): a sentence it
 * is unsure of is left to the ordinary reading, never made into a to-do.
 * In one clause (cut at «،», ",", ".", a line), with no question mark:
 *
 *   «كان/كانت/كنت لازم» (or «المفروض», «علي», «بدي») onto a first-person
 *   verb («أبعت», «ابعت»), and the first not-done words after it are that
 *   verb in the speaker's own past («وما بعتّه», «بس ما سلّمت», «وما دفعت»);
 *   "I was supposed to / should have / had to / needed to / meant to" + a
 *   verb, then "and/but (I) didn't (that verb)".
 *
 * Nothing but a time may stand before the obligation in its clause («مبارح
 * الساعة 9 الصبح»): «لو», «إذا», «ليش», «شو», «ممكن», «قال», «أخوي», «ما»,
 * «مش», "if", "why", "He said", "She" all leave the clause to the ordinary
 * reading. Nobody else may stand between the obligation and the not-done
 * words («بس هو ما بعت», "but it rained and I didn't").
 *
 * Narrowed on purpose: «نسيت أ…», «ما لحقت», «فاتني», «كنت ناوي», "I forgot
 * to", "I didn't get to", and every Hebrew phrasing are no longer read here
 * — they made to-dos of «نسيت اني حكيت معك», «ما لحقت أنام», «שכחתי להגיד
 * לך». They are read as before this change: the ordinary extraction and the
 * capture-chat prompt.
 *
 * «امبارح كان عندي اجتماع» told something that happened and stays no
 * commitment. A day ahead named in the same words («…بدي أبعته بكرا») is
 * the person's own plan and is read as said.
 */
const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';
const CLAUSE_CUT = new RegExp('[،,.;!\\n]+', 'u');
const QUESTION_MARK = new RegExp('[?؟]', 'u');
const LETTER = new RegExp('\\p{L}', 'u');
const PAST_DAY = new RegExp(`${B}[وب]?(?:مبارح|امبارح|إمبارح|أمس|امس|البارحة|البارحه)${A}|\\b(?:yesterday|last\\s+night|earlier(?:\\s+today)?|this\\s+(?:morning|afternoon|evening))\\b`, 'giu');
/** Words that may open a clause beside a time without changing who says what: «و», «أنا», "and", "so". */
const LEAD_FILLER = new RegExp(`${B}(?:و|بس|أنا|انا|والله|يعني|طيب)${A}|\\b(?:and|so|ok|okay|well|oh|today)\\b`, 'giu');
const AR_OBLIGED = new RegExp(`${B}[وف]?(?:كان|كانت|كنت)\\s+(?:لازم|لازمني|المفروض|مفروض|عليّ|علي|بدي|بدّي)\\s+([أا][\\p{L}\\p{M}]{2,})`, 'u');
const AR_NOT_DONE = new RegExp(`${B}(?:(?:بس|لكن)\\s+)?[وف]?(?:(?:لسا|لسّا|لسه|لسّه)\\s+)?(?:ما|مش)\\s+([\\p{L}\\p{M}]+)`, 'u');
/** Somebody else between the obligation and the not-done words: «بس هو ما بعت». */
const AR_SOMEBODY_ELSE = new RegExp(`${B}[وف]?(?:هو|هي|هم|هن|هما|انت|إنت|انتي|إنتي|انتو|إنتو|حدا|حدن)${A}`, 'u');
/** The speaker's own past: «دفعت», «بعتّه», «سلّمتها», «بعتتو». */
const AR_FIRST_PERSON_PAST = new RegExp('ت(?:ه|ها|هم|هن|و|ك|كم|لك|له|لها)?$', 'u');
/** A subject right after the not-done verb: «ما بعتلي حدا» is somebody else's doing. */
const AR_SUBJECT_AFTER = new RegExp(`^\\s+(?:حدا|حدن|هو|هي|هم|المدير|الموقع)${A}`, 'u');
/**
 * States, not things to do: «كان لازم أنام/أنتظر/أتأخر/أتعب وما …», "I had to
 * cry/sleep/wait and didn't". Their stems (first-person prefix off), and the
 * English verbs.
 */
const AR_STATE_STEMS = ['نام', 'نتظر', 'تأخر', 'تاخر', 'تعب', 'ضحك', 'بكي', 'بكى', 'رتاح', 'رتاخ', 'زعل', 'خاف'];
const EN_STATE_VERBS = new Set(['sleep', 'wait', 'cry', 'laugh', 'smile', 'rest', 'relax', 'be', 'feel', 'worry']);
const SHADDA = 'ّ';
const EN_OBLIGED = /\bI\s+(?:was\s+supposed\s+to|should\s+have|had\s+to|needed\s+to|meant\s+to)\s+([a-z]+)/i;
const EN_NOT_DONE = /\b(?:and|but)\s+(?:I\s+)?(?:still\s+)?(?:didn'?t|didn’t|did\s+not|never\s+did|haven'?t|have\s+not)\b(?:\s+([a-z]+))?/i;
const EN_SOMEBODY_ELSE = /\b(?:it|he|she|they|we|you|someone|somebody)\b/i;

const LEADING_ALEF = new RegExp('^[أاإ]', 'u');
const ARABIC_MARKS = new RegExp('[\\u064B-\\u065F\\u0670\\u0640]', 'gu');

/** Nothing but a time, a past day or a filler before the obligation. */
function opensWithTimeOnly(prefix: string): boolean {
  return !LETTER.test(stripTimeExpressions(prefix).replace(PAST_DAY, ' ').replace(LEAD_FILLER, ' '));
}

/**
 * «بعتّه» is the speaker's not-done «أبعت»: the same verb (same first
 * letter, the verb's last letter in it) in the first-person past. A verb
 * whose own last letter is «ت» needs more than its bare stem («بعت» may be
 * "he sent"): a shadda or a suffix.
 */
function speakerDidNot(verb: string, negated: string): boolean {
  const stem = verb.replace(ARABIC_MARKS, '').replace(LEADING_ALEF, '');
  if (AR_STATE_STEMS.some((state) => stem.startsWith(state))) return false;
  const done = negated.replace(ARABIC_MARKS, '').replace(LEADING_ALEF, '');
  if (done[0] !== stem[0] || !done.slice(1).includes(stem[stem.length - 1]!)) return false;
  if (!AR_FIRST_PERSON_PAST.test(done)) return false;
  return !stem.endsWith('ت') || done.length > stem.length || negated.includes(SHADDA);
}

function clauseIsMissedObligation(clause: string): boolean {
  const ar = AR_OBLIGED.exec(clause);
  if (ar && opensWithTimeOnly(clause.slice(0, ar.index))) {
    const rest = clause.slice(ar.index + ar[0].length);
    const after = AR_NOT_DONE.exec(rest);
    if (after && !AR_SOMEBODY_ELSE.test(rest.slice(0, after.index)) && speakerDidNot(ar[1]!, after[1]!)
      && !AR_SUBJECT_AFTER.test(rest.slice(after.index + after[0].length))) return true;
  }
  const en = EN_OBLIGED.exec(clause);
  if (en && !EN_STATE_VERBS.has(en[1]!.toLowerCase()) && opensWithTimeOnly(clause.slice(0, en.index))) {
    const rest = clause.slice(en.index + en[0].length);
    const after = EN_NOT_DONE.exec(rest);
    const next = after?.[1]?.toLowerCase();
    if (after && !EN_SOMEBODY_ELSE.test(rest.slice(0, after.index))
      && (!next || ['it', 'that', 'yet', 'do'].includes(next) || next.slice(0, 4) === en[1]!.toLowerCase().slice(0, 4))) return true;
  }
  return false;
}

/** The words tell a thing the speaker was to do and did not, with no day ahead of their own. */
export function isMissedObligation(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim() || QUESTION_MARK.test(rawText)) return false;
  if (!rawText.split(CLAUSE_CUT).some(clauseIsMissedObligation)) return false;
  return (relativeDayOffset(rawText) ?? 0) < 1 && readWeekdayReference(rawText) === null
    && !namesCalendarDate(rawText) && readRecurrence(rawText) === null;
}

/** The framing around the thing itself: the past day, "I was supposed to", "and I didn't", and never a word of lateness. */
const MISSED_FRAMING = new RegExp(
  [
    `${B}[وب]?(?:مبارح|امبارح|إمبارح|أمس|امس|البارحة|البارحه)${A}`,
    `${B}[وف]?(?:كان|كانت|كنت)\\s+(?:لازم|لازمني|المفروض|مفروض|عليّ|علي|بدي|بدّي)${A}`,
    `${B}[وف]?(?:فاتني|فاتتني|فاتك|فاتتك|متأخر|متأخرة|متاخر|متاخرة)${A}`,
    "\\b(?:yesterday|last\\s+night|earlier\\s+today)\\b",
    "\\bI\\s+(?:was\\s+supposed\\s+to|should\\s+have|had\\s+to|needed\\s+to|meant\\s+to)\\b|\\b(?:late|overdue|missed)\\b",
  ].join('|'),
  'giu',
);
/** "…and I did not": from the not-done words to the end. */
const NOT_DONE_TAIL = new RegExp(
  [
    `[\\s،,]+[وف]?(?:(?:بس|لكن)\\s+)?(?:(?:لسا|لسّا|لسه|لسّه)\\s+)?(?:ما|مش)${A}[\\s\\S]*$`,
    "[\\s,]+(?:and|but)\\s+(?:i\\s+)?(?:still\\s+)?(?:didn'?t|didn’t|did\\s+not|haven'?t|have\\s+not|never)\\b[\\s\\S]*$",
  ].join('|'),
  'iu',
);

export function missedThingTitle(text: string | null): string | null {
  if (!text) return text;
  const title = text.replace(MISSED_FRAMING, ' ').replace(NOT_DONE_TAIL, '').replace(/\s+/g, ' ').replace(/^[\s,،.:;-]+|[\s,،.:;-]+$/g, '').trim();
  return title.length >= 3 ? title : text;
}

/**
 * The missed thing as a thing to do today: today, no hour (the one it had
 * has gone), the framing out of its title, asked when. Never a passed time,
 * never "late".
 */
export function asThingToDoToday(result: ExtractionResult, rawText: string, context: ExtractionContext): ExtractionResult {
  const timezone = context.timezone || result.localTimeSpec?.timezone || 'UTC';
  const today = localTimeSpecFor(context.now, timezone)?.date;
  if (!today) return result;
  const named = missedThingTitle(result.title) ?? missedThingTitle(stripTimeExpressions(rawText));
  const action = missedThingTitle(result.action) ?? named;
  const { undatedTime: _undated, rangeMinutes: _range, recurrenceHint: _hint, ...rest } = result;
  return {
    ...rest,
    type: result.type === 'follow_up' ? 'follow_up' : 'task',
    title: named,
    action,
    dueAt: null,
    remindAt: null,
    allDay: false,
    localTimeSpec: { date: today, time: null, timezone },
    timeEvidence: 'day_only',
    dateInferred: false,
    missingFields: [...result.missingFields.filter((field) => field !== 'action' && field !== 'time'), 'time'],
    ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'informational_without_action' && flag !== 'vague_action' && flag !== 'no_action_verb'),
    confidence: { ...result.confidence, overall: Math.max(result.confidence.overall, 0.7), type: Math.max(result.confidence.type, 0.7), action: Math.max(result.confidence.action, 0.7) },
  };
}

