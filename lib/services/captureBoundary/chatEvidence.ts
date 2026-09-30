/**
 * What the person said, as the capture chat's items are checked against it
 * (capture chat, owner decision 2026-09-30).
 *
 * In the chat the model answers with the whole current list of items, built
 * from every turn: a time the person gives in a later turn ("make it 6",
 * «خلّيها الساعة 6») belongs to an item they named earlier. So an item is not
 * checked against one clause, as a capture's is, but against the person's
 * turns together — and never against anything the assistant said.
 *
 * Two things live here:
 *
 *   `chatEvidenceFrom`  the text every chat item is validated against: the
 *                       user's turns, joined, with any clause that refuses a
 *                       reminder («لا تذكرني», "don't add…") left out. A
 *                       refusal is an instruction about what not to keep; left
 *                       in, the validator would read the whole conversation as
 *                       negated and every later item would be lost with it.
 *   `withoutUnsaidTime` the chat's own guard, after the ordinary validator: an
 *                       hour, minute or day the person never said is taken
 *                       off, so the item is asked about rather than proposed
 *                       at a time somebody picked for them. The validator's
 *                       "no invented time" rule only fires when the words
 *                       state no time at all; a conversation that states *a*
 *                       time would otherwise let the model put down another.
 *
 * Pure: no clock of its own, no storage.
 */
import { CAPTURE_INPUT_MAX_CHARACTERS } from '../../../src/contracts/v1/captureContracts';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { splitCaptureClauseDetails, type CaptureClause } from '../../../src/extraction/clauseSplitter';
import { normalizeForInjectionScan } from '../../../src/extraction/ollamaExtractor';
import { statesNegatedReminder } from '../../../src/extraction/schemaValidator';
import {
  dayPartHour,
  hourWithDayPart,
  instantFromLocal,
  localTimeSpecFor,
  namesDayOfMonth,
  normalizeClockText,
  relativeDayOffset,
  statedClockHours,
  statesClock,
  thisMonthEndWords,
} from '../../../src/extraction/timeLexicon';
import { namesCalendarDate, readRecurrence, resolveWeekdayDate } from '../../../src/extraction/weekdayLexicon';
import { isNegatedRequest } from '../mobile/safety';

/** A clause that refuses a reminder, by either of the two checks the capture path makes. */
function refuses(text: string): boolean {
  return isNegatedRequest(text) || statesNegatedReminder(text);
}

/**
 * The person's turns, as evidence: each one whole, except that a turn which
 * refuses something keeps only its clauses that do not.
 */
export function chatEvidenceTurns(userTurns: readonly string[]): string[] {
  const out: string[] = [];
  for (const turn of userTurns) {
    const text = turn.trim();
    if (!text) continue;
    if (!refuses(text)) {
      out.push(text);
      continue;
    }
    for (const clause of splitCaptureClauseDetails(text)) {
      if (clause.text.trim() && !refuses(clause.text)) out.push(clause.text.trim());
    }
  }
  return out;
}

/** The evidence text itself: the kept turns, one per line. */
export function chatEvidenceFrom(userTurns: readonly string[]): string {
  return chatEvidenceTurns(userTurns).join('\n');
}

/*
 * ══ EACH ITEM ITS OWN WORDS (chat UAT, 2026-09-30) ══
 *
 * "I have a dentist appointment on Friday at 4pm and a meeting with Sara on
 * Sunday morning": the model answered the dentist on Friday at 16:00 and Sara
 * on Sunday at 09:00, both right. Read against the whole conversation, Sara's
 * item lost its day — the validator took the one clock the words state, 4pm,
 * for her too, and the guard knew only the first weekday of the turn, Friday,
 * so Sunday was "a day nobody said" — and one turn later, with the model
 * leaving her empty, the validator gave her the dentist's Friday.
 *
 * So each item is checked against the clauses that are about it: a clause
 * that names another item (by the words of its title) is that item's, not
 * this one's. A clause naming no item — "make it 6pm", «لا خلّي التانية
 * الساعة 7» — is everybody's, as the whole conversation was before. An item
 * no clause names (a title in other words than the person's) is read against
 * the whole conversation as before, but may carry only a day or an hour from
 * a clause that names no other item: in doubt, it is asked.
 */

/** Words too common in titles to say which item a clause is about. */
const TITLE_STOPWORDS = new Set([
  // en
  'the', 'and', 'with', 'for', 'have', 'has', 'had', 'need', 'needs', 'want', 'remind', 'reminder', 'about', 'from',
  'this', 'that', 'then', 'also', 'make', 'move', 'change', 'please', 'into', 'onto', 'some', 'get', 'got', 'can',
  'you', 'your', 'our', 'their', 'his', 'her', 'its', 'one', 'two', 'thing', 'things', 'something', 'today', 'tomorrow',
  // ar (folded: ة→ه, ى→ي, hamza forms → ا)
  'مع', 'عند', 'عندي', 'بدي', 'لازم', 'ذكرني', 'ذكرني', 'يوم', 'ساعه', 'الساعه', 'في', 'على', 'علي', 'عال', 'من', 'الي',
  'هاي', 'هاد', 'هدا', 'هذا', 'هذه', 'خلي', 'خليها', 'اليوم', 'بكرا', 'بكره', 'شي', 'اشي', 'كمان', 'انا', 'اني',
  // he
  'עם', 'של', 'את', 'צריך', 'צריכה', 'תזכיר', 'תזכירי', 'לי', 'יום', 'שעה', 'היום', 'מחר', 'גם', 'אני',
]);

/** Arabic clitics a word carries in front: «والثاني», «بخطبة», «للدكتور». */
const ARABIC_PREFIX = new RegExp('^(?:وال|بال|فال|كال|لل|ال)(?=\\p{L}{2})|^[وفبلك](?=\\p{L}{3})', 'u');
/** Hebrew prefixes: «ולרופא», «בפגישה». One letter, a word of three after it. */
const HEBREW_PREFIX = new RegExp('^[והבלמשכ](?=[\\u05D0-\\u05EA]{3})', 'u');

const TA_MARBUTA_END = new RegExp('ة$', 'u');
const ALIF_MAQSURA = new RegExp('ى', 'gu');
const NOT_WORD = new RegExp("[^\\p{L}\\p{N}']+", 'u');

/** A word folded so the person's spelling and the model's title meet. */
function foldWord(word: string): string {
  let folded = word.replace(/'s$/, '').replace(TA_MARBUTA_END, 'ه').replace(ALIF_MAQSURA, 'ي');
  folded = folded.replace(ARABIC_PREFIX, '');
  folded = folded.replace(HEBREW_PREFIX, '');
  return folded;
}

/** The words of a text, folded, without the ones too short or too common to tell items apart. */
function contentWords(text: string): string[] {
  const words = normalizeForInjectionScan(text.slice(0, CAPTURE_INPUT_MAX_CHARACTERS)).toLowerCase()
    .split(NOT_WORD)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    if (TITLE_STOPWORDS.has(word)) continue;
    const folded = foldWord(word);
    if (folded.length < 3 || TITLE_STOPWORDS.has(folded) || /^\d+$/.test(folded)) continue;
    out.push(folded);
  }
  return out;
}

/** Two folded words are the same word, or one is the other with an ending («صاحب»/«صاحبي», "meet"/"meeting"). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3;
}

/** How many words of a title the clause says. */
function titleScore(title: readonly string[], clause: readonly string[]): number {
  let score = 0;
  for (const word of Array.from(new Set(title))) if (clause.some((candidate) => sameWord(word, candidate))) score += 1;
  return score;
}

/** The title a model item carries, whatever shape it came in. */
function itemTitle(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title : '';
  return title.trim() ? title : typeof record.action === 'string' ? record.action : '';
}

/**
 * Whether a sentence is about this item and no other: it says a word only
 * this item's title has, and none only another's (folded as clauses are
 * matched). "Dentist at 4 and Sara on Sunday" is about both.
 */
export function namesOnlyItem(text: string, title: string, otherTitles: readonly string[]): boolean {
  const words = contentWords(text);
  const says = (word: string) => words.some((candidate) => sameWord(word, candidate));
  const mine = contentWords(title);
  const others = otherTitles.map((other) => contentWords(other));
  const distinct = (own: readonly string[], rest: readonly string[][]) =>
    own.filter((word) => !rest.some((other) => other.some((candidate) => sameWord(word, candidate))));
  if (!distinct(mine, others).some(says)) return false;
  return others.every((other, index) => !distinct(other, [mine, ...others.filter((_, at) => at !== index)]).some(says));
}

export interface ChatItemEvidence {
  /**
   * What the item is validated against, as the capture validates a clause:
   * `text` is its own clauses and those naming no item; `elliptical` and
   * `unreadDayWord` are its clause's, when that clause is the second of «…
   * الأول … والثاني …» (`clauseSplitter`).
   */
  clause: CaptureClause;
  /** The words whose days and hours the item may carry (`withoutUnsaidTime`). */
  turns: string[];
  /** The newest message is about this item (it names it, points at it, or names no item at all). */
  touchedNow: boolean;
}

/** An item of the list the person saw before this message, on their clock. */
export interface ChatPreviousItem {
  title: string;
  /** `YYYY-MM-DD`, or null. */
  date: string | null;
  /** `HH:MM`, or null. */
  time: string | null;
  /** It was still asking its question (a day, an hour, «الصبح ولا المسا؟»). */
  needsDayOrTime?: boolean;
}

interface AttributedClause {
  text: string;
  detail: CaptureClause;
  /** The items this clause names, or null when it names none (it is everybody's). */
  owners: number[] | null;
}

/*
 * «لا خلّي التانية الساعة 7», "make the second one 7pm", «תזיז את השני»: an
 * ordinal in a later message points at that item of the list the person saw
 * (chat UAT round 2, real Gemini: «التانية» shares no word with «الثاني», so
 * the edit read as nobody's, and the model's own retitling to «خلّي التانية»
 * made it the only words about the second item). «الساعة التانية» is two
 * o'clock, not an item. Folded the way `contentWords` folds.
 */
const ORDINALS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [0, ['first', 'اول', 'اولي', 'ראשון', 'ראשונה']],
  [1, ['second', 'ثاني', 'تاني', 'ثانيه', 'تانيه', 'שני', 'שנייה', 'שניה']],
  [2, ['third', 'ثالث', 'تالت', 'ثالثه', 'تالته', 'שלישי', 'שלישית']],
  [-1, ['last', 'اخير', 'اخيره', 'אחרון', 'אחרונה']],
];
const HOUR_WORD = new RegExp('(?:^|[^\\p{L}])(?:ال)?ساع[ةه]\\s+(?:ال)?(?:ثاني|تاني|ثانية|تانية|اولى|أولى|ثالثة|تالتة)', 'u');

/**
 * The places (from the start, or -1 for the last) the ordinals in the clause
 * point at — every one: «الأولى 4 المسا والتانية 6» is about both.
 */
function ordinalsOf(clause: string): number[] {
  if (HOUR_WORD.test(clause)) return [];
  const words = normalizeForInjectionScan(clause.slice(0, CAPTURE_INPUT_MAX_CHARACTERS)).toLowerCase()
    .split(NOT_WORD).map((word) => foldWord(word.replace(/^'+|'+$/g, '')));
  return ORDINALS.flatMap(([index, forms]) => (words.some((word) => forms.includes(word)) ? [index] : []));
}

/** The item's day and hour as the model gave them, on the person's clock. */
function modelWhen(item: unknown, timezone: string): string {
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  const spec = record.localTimeSpec as { date?: unknown; time?: unknown } | null | undefined;
  if (spec && typeof spec.date === 'string') return `${spec.date} ${typeof spec.time === 'string' ? spec.time : ''}`;
  const instant = typeof record.dueAt === 'string' ? record.dueAt : typeof record.remindAt === 'string' ? record.remindAt : null;
  const parsed = instant ? Date.parse(instant) : NaN;
  const local = Number.isFinite(parsed) ? localTimeSpecFor(new Date(parsed), timezone) : null;
  return local ? `${local.date} ${local.time}` : '';
}

/**
 * Which item of the previous list each returned item is: the same place when
 * the list kept its length (the model is told to keep the order), otherwise
 * the one whose title shares the most words, when only one does.
 */
export function alignToPrevious(items: readonly unknown[], previous: readonly ChatPreviousItem[]): Array<number | null> {
  if (previous.length === 0) return items.map(() => null);
  if (previous.length === items.length) return items.map((_, index) => index);
  const taken = new Set<number>();
  return items.map((item) => {
    const words = contentWords(itemTitle(item));
    const scores = previous.map((entry) => titleScore(contentWords(entry.title), words));
    const best = Math.max(0, ...scores);
    const at = scores.indexOf(best);
    if (best === 0 || scores.lastIndexOf(best) !== at || taken.has(at)) return null;
    taken.add(at);
    return at;
  });
}

/** A request to rename, in which a new title is the person's own words. */
const RENAME = /\b(?:rename|call\s+it|name\s+it|title)\b|(?:سمّي|سمي|اسمها|اسمه|عنوان|תקרא|שם\s+ל|תשנה\s+את\s+השם)/i;

/**
 * The model's items, each keeping the title it had when the model's new one
 * is only the words of the edit (chat UAT round 2: the second engagement came
 * back titled «خلّي التانية»). A rename the person asked for stands.
 */
export function withPreviousTitles(
  items: readonly unknown[],
  previous: readonly ChatPreviousItem[],
  newestMessage: string,
): unknown[] {
  if (previous.length === 0 || RENAME.test(newestMessage)) return [...items];
  const aligned = alignToPrevious(items, previous);
  const said = contentWords(newestMessage);
  return items.map((item, index) => {
    const before = aligned[index] === null ? null : previous[aligned[index]!]!;
    const title = itemTitle(item);
    if (!before || !title || title.trim() === before.title.trim() || !item || typeof item !== 'object') return item;
    const words = contentWords(title);
    const onlyTheEdit = words.every((word) => said.some((candidate) => sameWord(word, candidate)))
      && titleScore(contentWords(before.title), words) < contentWords(before.title).length;
    return onlyTheEdit ? { ...(item as Record<string, unknown>), title: before.title, action: before.title } : item;
  });
}

/**
 * Each chat item's evidence: the person's clauses about it and those about no
 * item in particular (see above). An item whose clauses are the whole
 * conversation is read exactly as before: against every turn, whole.
 *
 * With the list the person saw before this message (`previous`), a clause of
 * a later message is also that item's when it points at it by its place
 * («التانية», "the first one"), and a clause naming no item in the newest
 * message is the one item the model changed, when it changed exactly one
 * («خلّيها الساعة 7», "make it 5pm"): the edit is evidence for that item, not
 * for every item on the list.
 */
export function chatItemEvidence(
  userTurns: readonly string[],
  items: readonly unknown[],
  previous: readonly ChatPreviousItem[] = [],
  timezone = 'UTC',
): ChatItemEvidence[] {
  const perTurn = userTurns.map((turn) => chatEvidenceTurns([turn]));
  const newest = perTurn.length - 1;
  const turns = perTurn.flat();
  const whole = turns.join('\n');
  const aligned = alignToPrevious(items, previous);
  const titles = items.map((item, index) => {
    const before = aligned[index] === null ? '' : previous[aligned[index]!]!.title;
    return contentWords(`${itemTitle(item)} ${before}`);
  });
  const changed = items.flatMap((item, index) => {
    const at = aligned[index];
    if (at === null || at === undefined) return [];
    const before = previous[at]!;
    return modelWhen(item, timezone).trim() !== `${before.date ?? ''} ${before.time ?? ''}`.trim() ? [index] : [];
  });
  const itemAt = (place: number): number | null => {
    const target = place === -1 ? previous.length - 1 : place;
    const found = aligned.indexOf(target);
    return found === -1 ? null : found;
  };

  const turnOf: number[] = [];
  const byTurn: AttributedClause[][] = [];
  perTurn.forEach((texts, turnIndex) => {
    for (const turn of texts) {
      turnOf.push(turnIndex);
      byTurn.push(splitCaptureClauseDetails(turn)
        .filter((clause) => clause.text.trim())
        .map((clause) => {
          if (turnIndex > 0 && previous.length > 1) {
            const pointed = ordinalsOf(clause.text).map(itemAt).filter((at): at is number => at !== null);
            if (pointed.length > 0) return { text: clause.text.trim(), detail: clause, owners: Array.from(new Set(pointed)) };
          }
          const words = contentWords(clause.text);
          const scores = titles.map((title) => titleScore(title, words));
          const best = Math.max(0, ...scores);
          let owners = best > 0 ? scores.flatMap((score, index) => (score === best ? [index] : [])) : null;
          if (!owners && turnIndex === newest && turnIndex > 0 && changed.length === 1) owners = [changed[0]!];
          return { text: clause.text.trim(), detail: clause, owners };
        }));
    }
  });

  return items.map((_, index) => {
    const touchedNow = byTurn.some((clauses, at) => turnOf[at] === newest
      && clauses.some((clause) => clause.owners === null || clause.owners.includes(index)));
    const named = byTurn.some((clauses) => clauses.some((clause) => clause.owners?.includes(index)));
    if (!named) {
      // Read as before; but a day or an hour only from words naming no other item.
      const shared = byTurn.flatMap((clauses) => clauses.filter((clause) => clause.owners === null).map((clause) => clause.text));
      return { clause: { text: whole }, turns: shared, touchedNow };
    }
    const kept: string[] = [];
    const own: AttributedClause[] = [];
    turns.forEach((turn, turnIndex) => {
      const clauses = byTurn[turnIndex]!;
      const mine = clauses.filter((clause) => clause.owners === null || clause.owners.includes(index));
      own.push(...mine.filter((clause) => clause.owners !== null));
      // A turn all of whose clauses are this item's stays whole, as it was read.
      if (mine.length === clauses.length) kept.push(turn);
      else kept.push(...mine.map((clause) => clause.text));
    });
    const text = kept.join('\n');
    const single = own.length === 1 ? own[0]!.detail : null;
    return {
      clause: {
        text,
        ...(single?.elliptical ? { elliptical: true as const } : {}),
        ...(single?.unreadDayWord ? { unreadDayWord: single.unreadDayWord } : {}),
      },
      turns: kept,
      touchedNow,
    };
  });
}

/**
 * A model item that gives its wall clock (`localTimeSpec` with a day and an
 * hour) and no instant: the instant is the wall clock's (chat UAT round 2,
 * real Gemini: "every Saturday from 10 to 4" came back 10:00 with `dueAt`
 * null, and was asked «الصبح ولا المسا؟» for an hour it had).
 */
export function withInstantFromWallClock(item: unknown, timezone: string): unknown {
  if (!item || typeof item !== 'object') return item;
  const record = item as Record<string, unknown>;
  const spec = record.localTimeSpec as { date?: unknown; time?: unknown; timezone?: unknown } | null | undefined;
  if (record.dueAt || record.remindAt || record.allDay === true) return item;
  if (!spec || typeof spec.date !== 'string' || typeof spec.time !== 'string') return item;
  const zone = typeof spec.timezone === 'string' && spec.timezone ? spec.timezone : timezone;
  const instant = instantFromLocal(spec.date, spec.time, zone)?.toISOString();
  return instant ? { ...record, dueAt: instant } : item;
}

/** `YYYY-MM-DD` plus `days`. */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Minutes the words state on a clock ("6:30", «6 ونص» → 6:30), always including the hour itself. */
function statedMinutes(turn: string): Set<number> {
  const minutes = new Set<number>([0]);
  const text = normalizeClockText(turn);
  for (const match of Array.from(text.matchAll(/(\d{1,2})[:.](\d{2})/g))) minutes.add(Number(match[2]));
  return minutes;
}

export interface ChatTimeAllowance {
  /** Clock hours, modulo twelve, some turn states or names by its part of the day. */
  hours: Set<number>;
  minutes: Set<number>;
  /** The days the turns name, on the person's clock — and today, for a clock said with no day. */
  dates: Set<string>;
  /** The days the turns actually name, by a day word or a weekday: never the implied today. */
  namedDates: Set<string>;
  /** A turn states a date this guard cannot compute (a calendar date, a month's end, a recurrence): the validator's day stands. */
  anyDate: boolean;
}

/** What the person's turns allow an item to carry. */
export function chatTimeAllowance(turns: readonly string[], now: Date, timezone: string): ChatTimeAllowance {
  const today = localTimeSpecFor(now, timezone)?.date ?? null;
  const allowance: ChatTimeAllowance = { hours: new Set(), minutes: new Set([0]), dates: new Set(), namedDates: new Set(), anyDate: false };
  for (const turn of turns) {
    for (const hour of Array.from(statedClockHours(turn))) allowance.hours.add(hour);
    const part = dayPartHour(turn);
    if (part !== null) allowance.hours.add(part % 12);
    const paired = hourWithDayPart(turn);
    if (paired && paired !== 'ambiguous') allowance.hours.add(Number(paired.slice(0, 2)) % 12);
    for (const minute of Array.from(statedMinutes(turn))) allowance.minutes.add(minute);

    if (namesCalendarDate(turn) || thisMonthEndWords(turn) !== null || readRecurrence(turn) !== null || namesDayOfMonth(turn)) {
      allowance.anyDate = true;
    }
    const offset = relativeDayOffset(turn);
    if (today && offset !== null) allowance.namedDates.add(shiftDate(today, offset));
    const weekday = resolveWeekdayDate(turn, now, timezone);
    if (weekday) allowance.namedDates.add(weekday.date);
    for (const named of Array.from(allowance.namedDates)) allowance.dates.add(named);
    // A clock or a part of the day with no day of its own is today's, as the
    // capture path reads it — never a later day picked for the person.
    if (today && (statesClock(turn) || part !== null)) allowance.dates.add(today);
  }
  return allowance;
}

/** The item's local `HH:MM`, from its wall clock or its instant, or null when it has no hour. */
function localTimeOf(result: ExtractionResult, timezone: string): string | null {
  if (result.allDay) return null;
  if (result.localTimeSpec?.time) return result.localTimeSpec.time;
  const instant = result.remindAt ?? result.dueAt;
  if (!instant) return null;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? localTimeSpecFor(new Date(parsed), timezone)?.time ?? null : null;
}

/** The item's local day, or null when it has none. */
function localDateOf(result: ExtractionResult, timezone: string): string | null {
  if (result.localTimeSpec?.date) return result.localTimeSpec.date;
  const instant = result.remindAt ?? result.dueAt;
  if (!instant) return null;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? localTimeSpecFor(new Date(parsed), timezone)?.date ?? null : null;
}

export interface UnsaidTimeOutcome {
  result: ExtractionResult;
  /** True when a time or a day was taken off: the item must then be asked about. */
  fired: boolean;
}

/**
 * The same reading with any hour, minute or day the person never said taken
 * off (capture chat). What remains is asked, never filled by a guess:
 *
 *   an hour they did not say     the time goes; the day, if theirs, stays;
 *   a day they did not name      the day goes; an hour they did say is kept
 *                                as `undatedTime`, so the question is "which
 *                                day?" and not "when?" — unless the item's own
 *                                words name exactly one day: that is the day
 *                                they said for it, and it is put back.
 *
 * Hours compare modulo twelve («الساعة 6» is 06:00 or 18:00), so the half of
 * the day stays the validator's and the bare-early-hour question's to settle.
 */
export function withoutUnsaidTime(
  result: ExtractionResult,
  turns: readonly string[],
  now: Date,
  timezone: string,
): UnsaidTimeOutcome {
  const time = localTimeOf(result, timezone);
  const date = localDateOf(result, timezone);
  if (!time && !date) return { result, fired: false };
  const allowance = chatTimeAllowance(turns, now, timezone);

  let keepTime = true;
  if (time) {
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(3, 5));
    keepTime = allowance.hours.has(hour % 12) && allowance.minutes.has(minute);
  }
  const keepDate = !date || allowance.anyDate || allowance.dates.has(date);
  if (keepTime && keepDate) return { result, fired: false };

  // A day nobody said for this item, when its own words name exactly one day
  // (the model gave Sara the dentist's Friday; she was "on Sunday morning"):
  // that day is what the person said for it, and asking "which day?" would
  // ask for it again. Its hour stays only if the person said that too.
  const named = allowance.namedDates.size === 1 && !allowance.anyDate ? Array.from(allowance.namedDates)[0]! : null;
  if (!keepDate && named && !result.allDay) {
    const at = keepTime && time ? instantFromLocal(named, time, timezone)?.toISOString() ?? null : null;
    if (at) {
      const { undatedTime: _undated, ...rest } = result;
      return {
        fired: false,
        result: {
          ...rest,
          dueAt: result.dueAt || !result.remindAt ? at : null,
          remindAt: result.remindAt ? at : null,
          localTimeSpec: { date: named, time, timezone },
          dateInferred: false,
        },
      };
    }
  }
  const dayOfItsOwn = !keepDate && named && !result.allDay ? named : null;

  const missingFields = result.missingFields.includes('time') ? result.missingFields : [...result.missingFields, 'time' as const];
  const ambiguityFlags = result.ambiguityFlags.includes('vague_time') ? result.ambiguityFlags : [...result.ambiguityFlags, 'vague_time' as const];
  const { undatedTime: _undated, ...rest } = result;
  return {
    fired: true,
    result: {
      ...rest,
      dueAt: null,
      remindAt: null,
      allDay: false,
      // The item's own day when its words name one; only the hour is then asked.
      localTimeSpec: keepDate && date ? { date, time: null, timezone } : dayOfItsOwn ? { date: dayOfItsOwn, time: null, timezone } : null,
      dateInferred: keepDate ? result.dateInferred ?? false : false,
      // A said hour on an unsaid day: kept, so only the day is asked.
      ...(!keepDate && !dayOfItsOwn && keepTime && time ? { undatedTime: time } : {}),
      missingFields,
      ambiguityFlags,
      confidence: { ...result.confidence, time: Math.min(result.confidence.time, 0.1) },
    },
  };
}
