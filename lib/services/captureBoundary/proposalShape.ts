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
import { CAPTURE_INPUT_MAX_CHARACTERS, type CaptureGoalLinkSuggestionContract, type CaptureProposalItemContract } from '../../../src/contracts/v1/captureContracts';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { instantFromLocal, localTimeSpecFor, statedClockHours } from '../../../src/extraction/timeLexicon';
import { readWeekdayLists, type WeekdayList } from '../../../src/extraction/weekdayLexicon';
import { contentWords, sameWord } from './chatEvidence';

/** An active goal of the person's, as the capture is shown it: its id and its own words. */
export interface ActiveGoal {
  readonly goalId: string;
  readonly title: string;
}

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

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/*
 * The words allowed between a list of days and the hour that belongs to it:
 * "Tuesday and Thursday evenings at 7 PM", «الثلاثاء والخميس الساعة 7 المسا»,
 * «שלישי וחמישי ב-19:00», "at 7pm on Tuesday and Thursday". Anything else in
 * between — «عندي دوام وعندي دكتور الخميس», "meeting", ", party Thursday" —
 * means the hour is somebody else's, and the list is not this item's.
 */
const GAP_WORDS: ReadonlySet<string> = new Set([
  'at', 'on', 'in', 'the', 'from', 'by', 'around', 'about', 'both', 'evening', 'evenings', 'morning', 'mornings',
  'night', 'nights', 'afternoon', 'afternoons', 'pm', 'am', 'p', 'm', "o'clock", 'oclock',
  'الساعة', 'الساعه', 'ساعة', 'ساعه', 'عالساعة', 'عال', 'ع', 'على', 'حوالي', 'المسا', 'المساء', 'مسا', 'بالمسا',
  'الصبح', 'الصباح', 'صبح', 'بالصبح', 'العصر', 'الظهر', 'الضهر', 'بالليل', 'يوم', 'ب',
  'ב', 'בשעה', 'שעה', 'בערב', 'בבוקר', 'בצהריים', 'בלילה', 'ביום', 'יום', 'סביב', 'בסביבות',
]);
const DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/;

function gapAllowed(gap: string, ownWords: ReadonlySet<string> = new Set()): boolean {
  const words = gap.toLowerCase().split(/[\s,،.\-–:]+/).filter(Boolean);
  return words.length <= 4 + ownWords.size && words.every((word) => GAP_WORDS.has(word) || ownWords.has(word));
}

/**
 * The list of days this item's own hour belongs to, or null: the list, then
 * only hour words, then a clock whose hour is the item's — or the clock
 * first, then the list.
 */
/** Words that carry no thing of their own around a list: "I want to", «بدي», «عندي», «אני רוצה». */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'every', 'each', 'كل', 'כל', 'בכל',
  'i', "i'm", 'im', 'we', 'want', 'wanna', 'need', 'have', 'got', 'to', 'and', 'also', 'too', 'my', 'a', 'an', 'for', 'will', 'should', 'go', 'do',
  'بدي', 'بدّي', 'عندي', 'عنا', 'عنّا', 'لازم', 'كمان', 'و', 'رح', 'راح', 'انا', 'أنا', 'بس',
  'אני', 'רוצה', 'צריך', 'צריכה', 'יש', 'לי', 'וגם', 'גם', 'ו',
]);

const SPAN_BOUNDARY = /[,،;.!?؟:\n]/;

/**
 * The list of days this item's own hour belongs to, or null (audit
 * 2026-10-03 review, rounds 1 and 2). Three things must hold:
 *
 *   the hour     only hour words between the list and a clock whose hour is
 *                the item's ("evenings at 7 PM", «الساعة 7 المسا») — or the
 *                clock first, then the list; for an «كل»/every list the
 *                item's own title may sit between them too;
 *   the span     the stretch of words the list sits in (up to a comma or a
 *                full stop) names nothing but this item — its own title, the
 *                goal it serves, filler like "I want to" or «بدي». "I work
 *                every Tuesday and Thursday at 9am" is not the meeting's list;
 *   a name       a span that names no item at all ("Every Tuesday and
 *                Thursday at 7 PM" on its own) is only the list of items the
 *                model stacked on one of its days — the audit's failure.
 */
function attachedList(words: string, hour: number, titles: readonly string[], context: OccurrenceContext): WeekdayList | null {
  const lower = words.slice(0, CAPTURE_INPUT_MAX_CHARACTERS).toLowerCase();
  // Bounded like everything a parser reads here: never more than one capture.
  const tokens = (text: string) => text.slice(0, CAPTURE_INPUT_MAX_CHARACTERS).toLowerCase().split(/[\s,،.\-–:;!?؟()]+/).filter(Boolean);
  const own = new Set(tokens(titles.join(' ')));
  const goals = new Set(tokens((context.goalTitles ?? []).join(' ')));
  for (const list of readWeekdayLists(lower)) {
    let clockEnd = -1;
    const after = lower.slice(list.end, list.end + 80);
    const digitAt = after.search(DIGIT);
    if (digitAt !== -1 && gapAllowed(after.slice(0, digitAt), list.recurring ? own : new Set())) {
      const clock = after.slice(Math.max(0, digitAt - 12), digitAt + 12);
      const hours = statedClockHours(clock);
      if (hours.size === 1 && hours.has(hour % 12)) clockEnd = list.end + digitAt;
    }
    let clockStart = -1;
    if (clockEnd === -1) {
      const before = lower.slice(Math.max(0, list.start - 40), list.start);
      const lastDigit = Math.max(...Array.from(before).map((char, index) => (DIGIT.test(char) ? index : -1)));
      if (lastDigit >= 0) {
        const tail = before.slice(lastDigit + 1).replace(/^[0-9:.\s]*(?:am|pm|a\.m\.|p\.m\.)?/, '');
        const hours = statedClockHours(before.slice(Math.max(0, lastDigit - 14), lastDigit + 8));
        if (gapAllowed(tail) && hours.size === 1 && hours.has(hour % 12)) clockStart = Math.max(0, list.start - 40) + lastDigit;
      }
    }
    if (clockEnd === -1 && clockStart === -1) continue;
    // The span: from the boundary before the list (or its clock) to the one after.
    const from = clockStart === -1 ? list.start : clockStart;
    let spanStart = from;
    while (spanStart > 0 && !SPAN_BOUNDARY.test(lower[spanStart - 1]!)) spanStart -= 1;
    let spanEnd = Math.max(list.end, clockEnd);
    while (spanEnd < lower.length && !SPAN_BOUNDARY.test(lower[spanEnd]!)) spanEnd += 1;
    // A clock's own "7:30" holds a colon; read past it.
    if (lower[spanEnd] === ':' && DIGIT.test(lower[spanEnd + 1] ?? '')) {
      spanEnd += 1;
      while (spanEnd < lower.length && !SPAN_BOUNDARY.test(lower[spanEnd]!)) spanEnd += 1;
    }
    const rest = tokens(`${lower.slice(spanStart, list.start)} ${lower.slice(list.end, spanEnd)}`)
      .filter((word) => !DIGIT.test(word) && !GAP_WORDS.has(word) && !FILLER_WORDS.has(word));
    if (rest.some((word) => !own.has(word) && !goals.has(word))) continue;
    if (!rest.some((word) => own.has(word)) && !context.stacked) continue;
    return list;
  }
  return null;
}

/** The local day a raw model item names (its wall clock or its instant), or null. */
export function modelItemDay(item: unknown, timezone: string): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const spec = record.localTimeSpec as { date?: unknown } | null | undefined;
  if (spec && typeof spec.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(spec.date)) return spec.date;
  for (const key of ['dueAt', 'remindAt']) {
    const value = record[key];
    if (typeof value === 'string') return localDateOf(value, timezone);
  }
  return null;
}

/** The local `HH:MM` a raw model item names (its wall clock or its instant), or null. */
export function modelItemTime(item: unknown, timezone: string): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const spec = record.localTimeSpec as { time?: unknown } | null | undefined;
  if (spec && typeof spec.time === 'string' && /^\d{2}:\d{2}$/.test(spec.time)) return spec.time;
  for (const key of ['dueAt', 'remindAt']) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return localTimeSpecFor(new Date(parsed), timezone)?.time ?? null;
  }
  return null;
}

/** The title keys of a raw model item: its own words and its app-language title. */
export function modelItemKeys(item: unknown): string[] {
  if (!item || typeof item !== 'object') return [];
  const record = item as Record<string, unknown>;
  return [record.title, record.appTitle]
    .filter((title): title is string => typeof title === 'string' && title.trim().length > 0)
    .map((title) => titleKey(title))
    .filter(Boolean);
}

/**
 * Whether a list of days in these words belongs to this item at all
 * (`attachedList`), whatever the model did with it: a recurrence hint read
 * from a list that is somebody else's is dropped (round 2: "I work every
 * Tuesday and Thursday at 9am, and I have a meeting with Dana…").
 */
export function listBelongsTo(result: ExtractionResult, words: string, timezone: string, context: OccurrenceContext): boolean {
  if (result.allDay || !(result.dueAt || result.remindAt) || !words.trim()) return false;
  const time = result.localTimeSpec?.time ?? localTimeSpecFor(new Date(Date.parse((result.remindAt ?? result.dueAt)!)), timezone)?.time ?? null;
  if (!time) return false;
  return attachedList(words, Number(time.slice(0, 2)),
    [result.title ?? '', result.action ?? '', result.appTitle ?? '', result.sourceTitle ?? ''].filter(Boolean), { ...context, stacked: true }) !== null;
}

/** How this item came to its day, which decides whether a list of days may fan it out. */
export interface OccurrenceContext {
  /** The model put this item on a day itself: a list beside it is not the item's to fan out over. */
  modelPlacedDay: boolean;
  /** The model stacked two or more items of this title on one day (the audit's failure). */
  stacked: boolean;
  /** Days and hours (`YYYY-MM-DD HH:MM`) another of the model's items already holds: never spread onto them. */
  occupied?: ReadonlySet<string>;
  /** The titles of the goal-like items of the same list ("Learn React"): words a session's span may share. */
  goalTitles?: readonly string[];
}

/**
 * The days one item happens on, when the words attach a list of days to its
 * own hour (audit 2026-10-03 #1, and its review): "every Tuesday and Thursday
 * at 7 PM" is the coming Tuesday and Thursday — today too, when today is one
 * of them and the hour is still ahead — and never two items on one day.
 *
 * Null for anything else: one day; a list beside another hour or another
 * thing («الثلاثاء والخميس عندي دوام وعندي دكتور الخميس الساعة 5»); an item
 * with no settled hour or an all-day one; and — unless the list recurs
 * («كل», "every", «כל») or the model stacked copies on one day — an item the
 * model itself put on one day of the list: "Tuesday and Thursday" beside it
 * may be somebody else's days, and inventing an appointment is the worse
 * mistake.
 */
export function occurrenceDatesFor(
  result: ExtractionResult,
  words: string,
  now: Date,
  timezone: string,
  context: OccurrenceContext = { modelPlacedDay: false, stacked: false },
): string[] | null {
  if (result.allDay || !(result.dueAt || result.remindAt) || !words.trim()) return null;
  const date = result.localTimeSpec?.date ?? localDateOf(result.remindAt ?? result.dueAt, timezone);
  const time = result.localTimeSpec?.time ?? localTimeSpecFor(new Date(Date.parse((result.remindAt ?? result.dueAt)!)), timezone)?.time ?? null;
  if (!date || !time) return null;
  const list = attachedList(words, Number(time.slice(0, 2)),
    [result.title ?? '', result.action ?? '', result.appTitle ?? '', result.sourceTitle ?? ''].filter(Boolean), context);
  if (!list || !list.weekdays.includes(weekdayOf(date))) return null;
  if (!list.recurring && context.modelPlacedDay && !context.stacked) return null;
  const nowLocal = localTimeSpecFor(now, timezone);
  if (!nowLocal) return null;
  const todayWeekday = weekdayOf(nowLocal.date);
  const dates = list.weekdays.map((weekday) => {
    // Tonight's session of "every Tuesday…", said on Tuesday before it starts.
    if (list.recurring && weekday === todayWeekday && time > nowLocal.time) return nowLocal.date;
    return shiftDate(nowLocal.date, ((weekday - todayWeekday + 7) % 7) || 7);
  });
  // Never onto a day another item already holds at this hour ("Gym (Wed)"
  // for "Gym (Mon)", the meeting the list was not about).
  const free = dates.filter((day) => day === date || !context.occupied?.has(`${day} ${time}`));
  const unique = Array.from(new Set(free)).sort();
  return unique.length > 1 ? unique : null;
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

/** Arabic-Indic and Persian digits as Latin ones: «استمارة ٣» and "form 3" carry the same number. */
function foldDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
}

/** Words a title may carry for when it happens, and articles: "Study every Tuesday" is "Study". */
const KEY_DROPPED: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'on', 'at', 'every', 'each', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sun', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat',
  'كل', 'يوم', 'الأحد', 'الاحد', 'الاثنين', 'الثلاثاء', 'التلاتا', 'الأربعاء', 'الاربعاء', 'الأربعا', 'الخميس', 'الجمعة', 'السبت',
  'ثلاثاء', 'تلاتا', 'أربعاء', 'اربعاء', 'أربعا', 'خميس', 'جمعة', 'سبت',
  'כל', 'יום', 'ביום', 'ראשון', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת',
]);
const NON_WORD = new RegExp('[^\\p{L}\\p{M}\\p{N}]+', 'u');

/**
 * A title as two near-identical ones meet: case, spacing and punctuation
 * folded, articles and the words for when dropped ("Study every Tuesday" is
 * "study"). Every other word stays, short ones too ("Call Mo", "Call Jo"),
 * and numbers in any script's digits: "form 3" and «استمارة ٤» are two things.
 */
export function titleKey(title: string): string {
  return foldDigits(title).toLowerCase().split(NON_WORD).filter((word) => word && !KEY_DROPPED.has(word)).join(' ');
}

/**
 * Item ids that repeat an earlier item: at the same instant, and the same in
 * every title both have — the card's, and the person's own words when both
 * carry them. "Study math" and "Study physics" both shown «تدرس» are two
 * things; so are «عبي استمارة ٣» and «عبي استمارة ٤». The first one said
 * stays. Only timed items: two untimed asks each ask their own question.
 */
export function duplicateItemIds(
  items: readonly CaptureProposalItemContract[],
  sourceTitles: ReadonlyMap<string, string>,
): Set<string> {
  const duplicates = new Set<string>();
  const kept: Array<{ at: number; card: string; source: string }> = [];
  for (const item of items) {
    if (!item.resolvedTime || item.needsClarification) continue;
    const mine = { at: Date.parse(item.resolvedTime), card: titleKey(item.title), source: titleKey(sourceTitles.get(item.itemId) ?? '') };
    const same = kept.some((other) => other.at === mine.at
      && Boolean(mine.card || mine.source)
      && (!mine.card || !other.card || mine.card === other.card)
      && (!mine.source || !other.source || mine.source === other.source)
      && ((mine.card && other.card) || (mine.source && other.source)));
    if (same) duplicates.add(item.itemId);
    else kept.push(mine);
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
  // Learning and mastering only: "improve the slides" is a task, not a goal.
  new RegExp("^(?:i\\s+)?(?:(?:want|need|would\\s+like|'d\\s+like|plan|hope)\\s+to\\s+|wanna\\s+)?(?:learn|master|start\\s+learning)\\b", 'i'),
  new RegExp('^(?:بدي|بدّي|حابب|حابة|ناوي|ناوية)?\\s*(?:أ|ا|ت|ي|ن)?(?:تعلّم|تعلم|تقن)(?:وا|ي)?(?:\\s|$)', 'u'),
  new RegExp('^(?:(?:אני\\s+)?(?:רוצה|צריך|צריכה)\\s+)?(?:ללמוד|לשלוט\\s+ב)\\s*\\S', 'u'),
];

/** Whether an item's title (either one) is the goal its sessions serve. */
export function isGoalTitle(...titles: readonly (string | undefined)[]): boolean {
  return titles.some((title) => typeof title === 'string' && GOAL_OPENERS.some((pattern) => pattern.test(title.trim())));
}

/** The words that say what a goal or a session does, not what it is about: "learn", «أدرس», «ללמוד». */
const GOAL_VERB_WORDS = contentWords(
  'learn learning master improve better become study studying practice practise revise review start want would like tutorial course lesson lessons class session '
  + 'تعلم أتعلم اتعلم تتعلم يتعلم نتعلم تعلّم أدرس ادرس تدرس يدرس دراسة دراسه درس دروس حصة حصه حسّن أحسّن اتقن أتقن تمرين أتمرن اتمرن تتمرن بدي '
  + 'ללמוד לומד לומדת לשפר להשתפר לתרגל תרגול שיעור רוצה',
);

/*
 * Words that never say what a goal is about (audit 2026-10-03 review): "Read
 * more books" is not about "more", "Gym every Tuesday" not about Tuesday, and
 * "buy" is no topic. Days, hours, recurrence, quantities, time words and the
 * everyday verbs, in the three languages.
 */
const NOT_A_TOPIC = contentWords([
  'every each sunday monday tuesday wednesday thursday friday saturday weekend week weeks month year day days daily weekly',
  'today tonight tomorrow morning evening night afternoon noon minutes hours hour time times',
  'more less most some any many much lot lots little before after until during next last this that these those with without',
  'buy get read make take call send pick bring finish start stop keep have need want would like',
  'كل يوم ايام أيام اسبوع أسبوع شهر سنة سنه اليوم بكرا بكره الصبح المسا الليل العصر الظهر ساعة ساعه دقيقة',
  'اكتر أكتر اكثر أكثر أقل اقل شوي كتير قبل بعد لحد حتى هاد هاي هيك',
  'الأحد الاحد الاثنين الثلاثاء التلاتا الأربعاء الاربعاء الأربعا الخميس الجمعة السبت',
  'اشتري أشتري اقرأ اقرا أقرأ اعمل أعمل روح خذ اتصل أتصل ابعت أبعت جيب',
  'כל יום שבוע חודש שנה היום מחר בוקר ערב לילה שעה יותר פחות לפני אחרי',
  'ראשון שני שלישי רביעי חמישי שישי שבת לקנות לקרוא לעשות להתקשר',
  // Everyday verbs (round 2: "Play football" is not "Play guitar", «اكتب
  // بطاقة» is not «أكتب رسالة») and nouns too general to name a goal
  // ("House party" is not "Save money for a house").
  'play playing write writing watch see look save saving run running walk cook clean meet visit fix prepare plan book pay check find give help move tell ask eat drink sleep',
  'house home money party parties work school family friend friends people stuff thing things life health room office place card',
  'اكتب أكتب يكتب كتابة العب ألعب لعب شوف أشوف روح أروح اطبخ أطبخ نضف أنضف زور أزور وفر أوفر جهز أجهز حضر أحضر ادفع أدفع',
  'بيت دار شغل مصاري فلوس حفلة حفله مدرسة مدرسه عيلة عيله صحاب ناس اشيا أشياء بطاقة بطاقه',
  'לכתוב לשחק ללכת לראות לחסוך לבשל לנקות לפגוש לשלם בית כסף מסיבה עבודה משפחה חברים אנשים דברים',
].join(' '));

/** The words that say what something is about: no verb, no day or hour, nothing shorter than four letters. */
export function topicWords(text: string): string[] {
  return Array.from(new Set(contentWords(text).filter((word) => word.length >= 4
    && !GOAL_VERB_WORDS.some((verb) => sameWord(verb, word))
    && !NOT_A_TOPIC.some((common) => sameWord(common, word)))));
}

function sharesTopic(left: readonly string[], right: readonly string[]): number {
  return left.filter((word) => right.some((candidate) => sameWord(word, candidate))).length;
}

/**
 * The one active goal these words are about, or null: they share a topic word
 * with it (React, guitar, «سواقة»), and no other goal shares as many. A tie,
 * or a match only on a verb, a day or a common word, is no match: a goal link
 * the person did not mean is worse than none.
 */
export function matchingGoal(words: string, goals: readonly ActiveGoal[]): ActiveGoal | null {
  const said = topicWords(words);
  if (said.length === 0) return null;
  const scored = goals.map((goal) => ({ goal, score: sharesTopic(topicWords(goal.title), said) }));
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  if (best === 0) return null;
  const top = scored.filter((entry) => entry.score === best);
  return top.length === 1 ? top[0]!.goal : null;
}

/**
 * Whether a session is a session of this goal, by the session's own title
 * only — never by the words around it: it is about the same topic («درس
 * سواقة» for «تتعلم سواقة»), or it is a bare study session with no topic of
 * its own («تدرس», "Study") beside the goal it serves. "Call mom" at the
 * swimming lesson's hour is not a session of learning to swim.
 */
export function isSessionOf(goalTitles: readonly string[], sessionTitles: readonly string[], sessionClause = ''): boolean {
  const goal = topicWords(goalTitles.join('\n'));
  const own = sessionTitles.join('\n');
  const topics = topicWords(own);
  if (topics.length > 0) return sharesTopic(topics, goal) > 0;
  if (!contentWords(own).some((word) => GOAL_VERB_WORDS.some((verb) => sameWord(verb, word)))) return false;
  // A bare «تدرس», "Study": its own words say what for. "study for the
  // chemistry exam" is not a session of learning React (round 2) — every
  // topic its clause names must be the goal's.
  const said = topicWords(sessionClause);
  return said.every((word) => goal.some((candidate) => sameWord(word, candidate)));
}

export function goalLinkFor(goal: ActiveGoal): CaptureGoalLinkSuggestionContract {
  return { goalId: goal.goalId, title: goal.title };
}

/* ── a title's leftovers (audit 2026-10-03 review, round 2) ── */

const CONNECTORS: ReadonlySet<string> = new Set(['and', '&', 'or', 'then', 'also', 'و', 'ثم', 'وبعدين', 'وكمان', 'ו', 'וגם', 'או', '-', '–', ',', '،']);
const DAY_NAMES = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|(?:ال)?(?:أحد|احد|اثنين|إثنين|ثلاثاء|ثلثاء|تلاتا|أربعاء|اربعاء|أربعا|اربعا|خميس|جمعة|جمعه|سبت)|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)';
/** A day left behind by a list the parser took apart: «וחמישי», «والخميس». */
const JOINED_DAY = new RegExp(`^(?:و|ו)(?:ب)?${DAY_NAMES}$`, 'iu');
const BARE_DAY = new RegExp(`^${DAY_NAMES}$`, 'iu');

/**
 * The title without the connectors and list days a rules reading leaves at
 * its edges: «and gym» → «gym», «gym and» → «gym», «חדר כושר וחמישי» →
 * «חדר כושר». A title that would be left with nothing stays as it was.
 */
export function tidyTitle(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const edge = (word: string) => CONNECTORS.has(word.toLowerCase()) || JOINED_DAY.test(word);
  let start = 0;
  let end = words.length;
  while (start < end && edge(words[start]!)) start += 1;
  for (;;) {
    if (end > start && edge(words[end - 1]!)) { end -= 1; continue; }
    // "… and Thursday": a connector and a day, at the end.
    if (end - start >= 2 && BARE_DAY.test(words[end - 1]!) && CONNECTORS.has(words[end - 2]!.toLowerCase())) { end -= 2; continue; }
    break;
  }
  const tidy = words.slice(start, end).join(' ');
  return tidy || title.trim();
}
