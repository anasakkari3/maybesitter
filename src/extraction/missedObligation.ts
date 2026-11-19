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
 * of #872, rounds 2 to 4; coordinator decisions 2026-11-19). A sentence it
 * is unsure of is left to the ordinary reading — the model and the rules —
 * never made into a to-do. In one clause (cut at «،», ",", ".", a line),
 * with no question mark, no recurrence and no day of its own:
 *
 *   «كان/كانت/كنت لازم» (or «المفروض», «علي») onto an ACTION verb of the
 *   speaker's («أدفع», «أتصل», «أسلّم», «أبعت», «أحجز», «أشتري»… —
 *   `AR_ACTION_STEMS`), then a real OBJECT («الفاتورة», «بالسباك», «على
 *   المدير», «٢٠ شيكل»), then a joiner («و», «بس», «لكن», «ولسا»), then
 *   «ما» and that same verb in the speaker's own past («دفعتها», «اتصلت»,
 *   «سلّمته»); "I was supposed to / should have / had to / needed to / meant
 *   to" + an ACTION verb (`EN_ACTION_VERBS`) + an object, then "and/but (I)
 *   didn't".
 *
 * Why a list of action verbs and a required object, rather than a list of
 * verbs that are not tasks (round 4): a missing-from-the-list verb then
 * falls to the ordinary reading instead of becoming a card. A feeling, a
 * result or a state («أصبر», «أفرح», «أنجح», "known", "win") is no action; an
 * event whose time has gone («أحضر الحفلة», «ألحق الباص», «أوصل»,
 * «أروح عالعرس», "attend", "catch") is no action either, and going somewhere
 * is left out whole — «أروح عالصيدلية» is given up with it. «أحضّر» counts
 * only with its shadda ("prepare"), never «أحضر» ("attend"). «بدي» is a wish
 * and is not read. A verb alone («كان لازم أحجز وما حجزت»), or with only a
 * pronoun, a place or a manner word after it («أرد عليه بقسوة», «أكون
 * هناك», «أخلص بدري»), is not read.
 *
 * Only a time, a past day or a filler may open the clause before the
 * obligation («لو», «قال», «ما», "If", "She" leave it alone), and nothing but
 * the joiner may stand between the object and «ما» («وأمي ما دفعت», «بس
 * الدكتورة ما سلمت» are somebody else's).
 *
 * Narrowed earlier: «نسيت أ…», «ما لحقت», «فاتني», «كنت ناوي», "I forgot
 * to", "I didn't get to", and every Hebrew phrasing are not read here.
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
const WHITESPACE = new RegExp('\\s+', 'u');
const PAST_DAY = new RegExp(`${B}[وب]?(?:مبارح|امبارح|إمبارح|أمس|امس|البارحة|البارحه)${A}|\\b(?:yesterday|last\\s+night|earlier(?:\\s+today)?|this\\s+(?:morning|afternoon|evening))\\b`, 'giu');
/** Words that may open a clause beside a time without changing who says what: «و», «أنا», "and", "so". */
const LEAD_FILLER = new RegExp(`${B}(?:و|بس|أنا|انا|والله|يعني|طيب)${A}|\\b(?:and|so|ok|okay|well|oh|today)\\b`, 'giu');
/** "Every day", «كل شهر»: a recurrence is no one thing to do today. */
const EVERY = new RegExp(`${B}[وب]?كل\\s+(?:يوم|ليلة|ليله|شهر|أسبوع|اسبوع|جمعة|جمعه|سنة|سنه|صبح|مسا|ساعة|ساعه)${A}|\\b(?:every|each)\\s+[a-z]+|\\b(?:daily|weekly|monthly)\\b`, 'iu');
const AR_OBLIGED = new RegExp(`${B}[وف]?(?:كان|كانت|كنت)\\s+(?:لازم|لازمني|المفروض|مفروض|عليّ|علي)\\s+([أا][\\p{L}\\p{M}]{1,})`, 'u');
/** «ما»/«مش», with a «و» glued to it or not. */
const AR_NEGATION = new RegExp(`${B}([وف]?)(?:ما|مش)${A}`, 'u');
const AR_NEXT_WORD = new RegExp('^\\s+([\\p{L}\\p{M}]+)', 'u');
/** Words standing between the object and «ما» that only join: «و», «بس», «ولسا», «وأنا». */
const AR_JOINERS = new Set(['و', 'بس', 'لكن', 'ولكن', 'ولسا', 'ولسّا', 'ولسه', 'ولسّه', 'وأنا', 'وانا', 'واني', 'وإني']);
const AR_JOIN_FILLER = new Set(['لسا', 'لسّا', 'لسه', 'لسّه', 'أنا', 'انا']);
/**
 * Verbs of something to do — a payment, a call, a hand-in, a booking, an
 * errand with a thing — as their stems with the first-person prefix off,
 * vowel marks and shadda off, alef and ya folded.
 */
const AR_ACTION_STEMS = new Set([
  'دفع', 'سدد', 'سلم', 'تصل', 'كلم', 'جدد', 'رجع', 'رد', 'حجز', 'عبي', 'مضي', 'وقع', 'بعت', 'بعث', 'رسل',
  'شتري', 'طبع', 'عمل', 'نهي', 'خلص', 'سقي', 'نزل', 'جيب', 'طلب', 'حول', 'جاوب', 'فتح', 'راجع', 'حط',
  'سجل', 'كتب', 'نظف', 'نضف', 'رتب', 'غسل', 'شحن', 'صلح', 'قدم', 'لغي', 'بلغ', 'جهز', 'حضر', 'طلع',
]);
/** «أحضّر» is "prepare" only with its shadda; bare it is «أحضر» "attend". */
const AR_NEEDS_SHADDA = new Set(['حضر']);
/** Verbs of going: their object must be a thing, not a direction («أرجع الكتاب», «أطلع الزبالة»; never «أرجع عالبيت», «أطلع من الشغل»). */
const AR_MOTION_STEMS = new Set(['رجع', 'نزل', 'طلع']);
const AR_DIRECTION = new RegExp('^(?:ع|عال|عل|على|لل|إلى|الى|لعند)', 'u');
const AR_PREPOSITIONS = new Set(['على', 'ع', 'مع', 'عن', 'ل', 'عند', 'من', 'في', 'إلى', 'الى']);
/** After the verb these are no object: a pronoun with a preposition, a place, a manner, a time. */
const AR_NOT_AN_OBJECT = new Set([
  'عليه', 'عليها', 'عليهم', 'عليك', 'عليكم', 'معه', 'معها', 'معهم', 'معك', 'معو', 'له', 'لها', 'لهم', 'لك', 'إله', 'الها',
  'فيه', 'فيها', 'فيهم', 'منه', 'منها', 'عنده', 'عندها', 'حالي', 'حالك', 'حاله', 'هون', 'هناك', 'هنيك', 'بدري', 'بكير',
  'منيح', 'كتير', 'شوي', 'هيك', 'كمان', 'برضو', 'أبدا', 'ابدا', 'أبداً', 'ابداً', 'بالمرة', 'مرة', 'هسا', 'هلأ', 'هلق', 'هلّق', 'هلا',
]);
const EN_OBLIGED = /\bI\s+(?:was\s+supposed\s+to|should\s+have|had\s+to|needed\s+to|meant\s+to)\s+([a-z]+)/i;
const EN_NOT_DONE = /\b(?:and|but)\s+(?:I\s+)?(?:still\s+)?(?:didn'?t|didn’t|did\s+not|never\s+did|haven'?t|have\s+not)\b(?:\s+([a-z]+))?/i;
const EN_SOMEBODY_ELSE = /\b(?:it|he|she|they|we|you|someone|somebody)\b/i;
/** English verbs of something to do, and the past forms "should have …" takes. */
const EN_PAST_TO_BASE: Readonly<Record<string, string>> = {
  paid: 'pay', called: 'call', sent: 'send', submitted: 'submit', booked: 'book', bought: 'buy', renewed: 'renew',
  returned: 'return', written: 'write', wrote: 'write', emailed: 'email', texted: 'text', replied: 'reply',
  cleaned: 'clean', cancelled: 'cancel', canceled: 'cancel', ordered: 'order', fixed: 'fix', signed: 'sign',
  filed: 'file', registered: 'register', finished: 'finish', printed: 'print', transferred: 'transfer',
  scheduled: 'schedule', brought: 'bring', picked: 'pick', mailed: 'mail', applied: 'apply', completed: 'complete',
  contacted: 'contact', phoned: 'phone', washed: 'wash', charged: 'charge', posted: 'post', renewd: 'renew',
};
const EN_ACTION_VERBS = new Set([...Object.values(EN_PAST_TO_BASE)]);
const EN_NOT_AN_OBJECT = new Set(['it', 'him', 'her', 'them', 'me', 'you', 'us', 'up', 'down', 'out', 'off', 'better', 'there', 'here', 'home', 'again', 'on', 'at', 'in', 'to', 'yesterday', 'today', 'now', 'then', 'back', 'anything', 'something']);

const LEADING_ALEF = new RegExp('^[أاإ]', 'u');
const ARABIC_MARKS = new RegExp('[\\u064B-\\u065F\\u0670\\u0640]', 'gu');
const SHADDA = 'ّ';
/** The speaker's own past: «دفعت», «بعتّه», «سلّمتها», «بعتتو». */
const AR_FIRST_PERSON_PAST = new RegExp('ت(?:ه|ها|هم|هن|و|ك|كم|لك|له|لها)?$', 'u');
/** A subject right after the not-done verb: «ما بعته حدا» is somebody else's doing. */
const AR_SUBJECT_AFTER = new RegExp(`^\\s+(?:حدا|حدن|هو|هي|هم)${A}`, 'u');

const ALEF_FORMS = new RegExp('[أإآ]', 'gu');
const ALEF_MAQSURA = new RegExp('ى', 'gu');

function foldArabic(word: string): string {
  return word.replace(ARABIC_MARKS, '').replace(LEADING_ALEF, '').replace(ALEF_FORMS, 'ا').replace(ALEF_MAQSURA, 'ي');
}

/** Nothing but a time, a past day or a filler before the obligation. */
function opensWithTimeOnly(prefix: string): boolean {
  return !LETTER.test(stripTimeExpressions(prefix).replace(PAST_DAY, ' ').replace(LEAD_FILLER, ' '));
}

/** The words after the verb name a thing it is done to: a noun, or a preposition and a noun. */
function namesAnObject(words: string, notAnObject: ReadonlySet<string>, motion = false): boolean {
  const tokens = stripTimeExpressions(words).replace(PAST_DAY, ' ').split(WHITESPACE).filter((token) => LETTER.test(token));
  let at = 0;
  if (AR_PREPOSITIONS.has(tokens[0] ?? '')) {
    if (motion) return false;
    at = 1;
  }
  const first = tokens[at]?.replace(ARABIC_MARKS, '').toLowerCase();
  if (!first || first.length < 2 || notAnObject.has(first)) return false;
  return !(motion && AR_DIRECTION.test(first));
}

/**
 * «بعتّه» is the speaker's not-done «أبعت»: the same verb — its first letter,
 * its second (or a hollow «جيب» → «جبت»), its last letter in it — in the
 * first-person past. A verb whose own last letter is «ت» needs more than its
 * bare stem («بعت» may be "he sent"): a shadda or a suffix.
 */
function speakerDidNot(stem: string, negated: string): boolean {
  const done = foldArabic(negated);
  if (done[0] !== stem[0]) return false;
  if (done[1] !== stem[1] && !'يوا'.includes(stem[1] ?? '')) return false;
  if (!done.slice(1).includes(stem[stem.length - 1]!)) return false;
  if (!AR_FIRST_PERSON_PAST.test(done)) return false;
  return !stem.endsWith('ت') || done.length > stem.length || negated.includes(SHADDA);
}

function arabicClauseIsMissed(clause: string): boolean {
  const ar = AR_OBLIGED.exec(clause);
  if (!ar || !opensWithTimeOnly(clause.slice(0, ar.index))) return false;
  const stem = foldArabic(ar[1]!);
  if (!AR_ACTION_STEMS.has(stem) || (AR_NEEDS_SHADDA.has(stem) && !ar[1]!.includes(SHADDA))) return false;
  const rest = clause.slice(ar.index + ar[0].length);
  const negation = AR_NEGATION.exec(rest);
  if (!negation) return false;
  // Between the object and «ما»: only the joiner («و», «بس», «ولسا»…).
  const words = rest.slice(0, negation.index).trim().split(WHITESPACE).filter(Boolean);
  let joined = negation[1] === 'و';
  while (words.length > 0 && (AR_JOINERS.has(words[words.length - 1]!) || AR_JOIN_FILLER.has(words[words.length - 1]!))) {
    if (AR_JOINERS.has(words.pop()!)) joined = true;
  }
  if (!joined || words.some((word) => word === 'بس' || word === 'لكن')) return false;
  if (!namesAnObject(words.join(' '), AR_NOT_AN_OBJECT, AR_MOTION_STEMS.has(stem))) return false;
  const after = rest.slice(negation.index + negation[0].length);
  const negated = AR_NEXT_WORD.exec(after);
  if (!negated || !speakerDidNot(stem, negated[1]!)) return false;
  return !AR_SUBJECT_AFTER.test(after.slice(negated[0].length));
}

function englishClauseIsMissed(clause: string): boolean {
  const en = EN_OBLIGED.exec(clause);
  if (!en || !opensWithTimeOnly(clause.slice(0, en.index))) return false;
  const said = en[1]!.toLowerCase();
  const verb = EN_PAST_TO_BASE[said] ?? said;
  if (!EN_ACTION_VERBS.has(verb)) return false;
  const rest = clause.slice(en.index + en[0].length);
  const after = EN_NOT_DONE.exec(rest);
  if (!after) return false;
  const object = rest.slice(0, after.index);
  if (EN_SOMEBODY_ELSE.test(object) || !namesAnObject(object, EN_NOT_AN_OBJECT)) return false;
  const next = after[1]?.toLowerCase();
  return !next || ['it', 'that', 'yet', 'do'].includes(next) || (EN_PAST_TO_BASE[next] ?? next) === verb;
}

function clauseIsMissedObligation(clause: string): boolean {
  if (EVERY.test(clause)) return false;
  return arabicClauseIsMissed(clause) || englishClauseIsMissed(clause);
}

/** The words tell a thing the speaker was to do and did not, with no day ahead of their own. */
export function isMissedObligation(rawText: string): boolean {
  if (typeof rawText !== 'string' || !rawText.trim() || QUESTION_MARK.test(rawText)) return false;
  if (!rawText.split(CLAUSE_CUT).some(clauseIsMissedObligation)) return false;
  return (relativeDayOffset(rawText) ?? 0) < 1 && readWeekdayReference(rawText) === null
    && !namesCalendarDate(rawText) && readRecurrence(rawText) === null;
}

/** The framing around the thing itself: the past day, "I was supposed to", and never a word of lateness. */
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
/**
 * Where "…and I did not" starts. Found, then cut with `slice` — a pattern
 * that ran to the end (`[\s\S]*$`) after a run of spaces was quadratic on a
 * long one (review round 4: 14.6 s on 100,000 characters).
 */
const NOT_DONE_START = new RegExp(
  [
    `(?:^|[\\s،,])[وف]?(?:(?:بس|لكن)\\s+)?(?:(?:لسا|لسّا|لسه|لسّه)\\s+)?(?:ما|مش)${A}`,
    "[\\s,](?:and|but)\\s+(?:i\\s+)?(?:still\\s+)?(?:didn'?t|didn’t|did\\s+not|haven'?t|have\\s+not|never)\\b",
  ].join('|'),
  'iu',
);
const EDGE = new Set([' ', '\t', '\n', ',', '،', '.', ':', '：', ';', '-', '–', '—']);

/** The text without the given characters at either edge, scanned once from each side. */
export function trimEdgeCharacters(text: string, edge: ReadonlySet<string> = EDGE): string {
  let start = 0;
  let end = text.length;
  while (start < end && edge.has(text[start]!)) start += 1;
  while (end > start && edge.has(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

export function missedThingTitle(text: string | null): string | null {
  if (!text) return text;
  const framed = text.replace(MISSED_FRAMING, ' ');
  const tail = NOT_DONE_START.exec(framed);
  let title = trimEdgeCharacters((tail ? framed.slice(0, tail.index) : framed).replace(/\s+/g, ' '));
  // "should have renewed my license" is "renew my license" to do.
  const first = /^([a-z]+)\b/i.exec(title)?.[1];
  const base = first ? EN_PAST_TO_BASE[first.toLowerCase()] : undefined;
  if (base) title = `${base}${title.slice(first!.length)}`;
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

