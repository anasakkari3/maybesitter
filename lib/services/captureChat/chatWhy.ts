/**
 * The capture chat's "why" and its clashes (owner request 2026-09-30: "the
 * agent cannot describe what the commitment is if there is a collision, and he
 * cannot explain why he suggests that to me").
 *
 * Two things the reply must now do, and one it must never do:
 *
 *   name a clash       an item whose time lands on something the person
 *                      already has (`chatConflicts`) is said in the reply —
 *                      the model is shown the clashes and asked to name them;
 *                      when its reply does not, one short sentence in the app's
 *                      language is added (`withConflictsNamed`). The calendar's
 *                      busy time has no title, and none is invented: "your
 *                      calendar shows you busy then".
 *   give a reason      a reply that sets or changes a time may say why — and
 *                      only from the person's own words or the list: the day
 *                      or hour they said, their part of the day, their weekly
 *                      phrase, their edit, or a clash. A reason that brings in
 *                      anything else ("because mornings are better for your
 *                      energy") is not theirs, and its sentence is taken out
 *                      (`groundedReply`).
 *   never invent one   a sentence that claims a clash when there is none, or
 *                      offers another time when nothing clashes, is taken out
 *                      the same way: an offer is for a clash only, and a "yes"
 *                      to it moves the item (`chatEvidence`, the accepted offer).
 *
 * Pure: the clock and the zone are the caller's. Every check reads at most
 * `CHAT_REPLY_SCAN_LIMIT` characters, as the other reply checks do.
 */
import type { CaptureItemConflictContract } from '../../../src/contracts/v1/captureContracts';
import { foldInjectionPattern, normalizeForInjectionScan } from '../../../src/extraction/ollamaExtractor';
import { dayPartHour, localTimeSpecFor, relativeDayOffset, statedClockHours } from '../../../src/extraction/timeLexicon';
import { resolveWeekdayDate } from '../../../src/extraction/weekdayLexicon';
import { chatTimeAllowance, contentWords, offerSentences, sameWord } from '../captureBoundary/chatEvidence';
import type { ChatLanguage } from './chatReply';

const CHAT_REPLY_SCAN_LIMIT = 2_000;
/** The longest title a clash sentence quotes. */
const CLASH_TITLE_MAX = 60;
/** The most clash sentences added to one reply. */
const MAX_ADDED_CLASHES = 2;

const LRI = '\u2066';
const FSI = '\u2068';
const PDI = '\u2069';

type ConflictLike = Pick<CaptureItemConflictContract, 'title' | 'startsAt' | 'endsAt' | 'kind' | 'inProposal'>;

/** An item of the proposal, as far as the reply's grounds need it. */
export interface GroundsItem {
  title: string;
  resolvedDate?: string;
  /**
   * Where the item's clashes were measured from (`candidateIntervalOf`: its
   * due time, not a reminder before it): which clash to name first.
   */
  collisionStart?: string | null;
  conflicts?: readonly ConflictLike[];
}

/**
 * The clash a reply names for an item: one that starts when the item does,
 * if any, else the first. A meeting at 10:00 beside a 09:00–17:00 offsite and
 * a lawyer at 10:00 names the lawyer (load pass F4, 2026-10-07): the same
 * hour is the clash the person most needs to hear; the review lists them all.
 */
export function namedClash(item: GroundsItem): ConflictLike | undefined {
  const conflicts = item.conflicts ?? [];
  // The collision start, never `resolvedTime`: that is the reminder when one
  // is set, and a 09:30 reminder for a 10:00 meeting named the offsite again
  // (Codex inspection F4-003).
  const start = item.collisionStart ? Date.parse(item.collisionStart) : Number.NaN;
  if (!Number.isFinite(start)) return conflicts[0];
  return conflicts.find((conflict) => Date.parse(conflict.startsAt) === start) ?? conflicts[0];
}

/** What a reply may be grounded in: the person's words, and the list. */
export interface ReplyGrounds {
  /** The person's turns, as their items' evidence (a "yes" to an offer carries it). */
  userTurns: readonly string[];
  items: readonly GroundsItem[];
  now: Date;
  timezone: string;
}

/** A reply's sentences, each with its own end mark (as `chatReply` splits them). */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?؟…])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

const fold = (text: string): string => normalizeForInjectionScan(text.slice(0, CHAT_REPLY_SCAN_LIMIT)).toLowerCase();

/* ── what a reason is ──────────────────────────────────────────────── */

/** Where a reason starts: «لأنك», «عشان», "because", «כי». */
const REASON_MARKERS: readonly RegExp[] = [
  foldInjectionPattern(new RegExp(
    '(?<![\\p{L}\\p{M}])(?:(?:لأن|لإن|لان)\\p{L}{0,2}|عشان|علشان|مشان|منشان|كونك|بما\\s+(?:إن|ان|انو|إنو)\\p{L}{0,2})(?![\\p{L}\\p{M}])',
    'u',
  )),
  /\b(?:because|since|as\s+you|'?cause|given\s+that)\b/i,
  new RegExp('(?:^|\\s)(?:כי|בגלל|מכיוון|היות\\s+ש|משום\\s+ש)(?=\\s|$)', 'u'),
];

/** Where a reason ends: a pause, or the next clause («، وإذا بدك…», ", but…»). */
const REASON_END = new RegExp(
  `[,،;:—–(]|\\s(?:${foldInjectionPattern(new RegExp('وإذا|واذا|ولو|بس', 'u')).source})(?=\\s|$)|\\s(?:and\\s+if|but|if)\\s|\\s(?:אבל|ואם)\\s`,
  'iu',
);

/** Words a grounded reason is made of besides the person's own: saying, asking, clashing, the calendar. */
const REASON_WORDS: ReadonlySet<string> = new Set(contentWords([
  // ar
  'حكيت قلت ذكرت طلبت كتبت اخترت وافقت غيرت عدلت حكيتلي قلتلي حكيته قلته بدك بدكياها بدكها ياها حابب',
  'بيتعارض يتعارض تتعارض بتتعارض تعارض متعارض متعارضة بيتقاطع يتقاطع تقاطع مشغول مشغولة تقويمك تقويم عندك موعد موعدك',
  'وقت الوقت وقتها نفس نفسه هيك هون كلامك حكيك رسالتك اللي انك انو إنو إنك ساعة الساعة أسبوع الأسبوع أسبوعي ثابت كل',
  'كنت بالزبط زي متل مثل بيجي بتيجي فيه فيها هو هي',
  // en
  'said told asked mentioned wrote wanted want chose picked agreed changed edited clashes clash conflicts conflict overlaps overlap',
  'busy calendar already there time same slot yours schedule every week weekly accepted yes message what when was were are',
  'which would instead exactly right it\'s that\'s there\'s saying say',
  // he
  'אמרת ביקשת ציינת כתבת רצית בחרת הסכמת שינית מתנגש מתנגשת חופף חופפת עסוק עסוקה תפוס תפוסה היומן יומן כבר שלך זמן',
  'אותו אותה בדיוק כל שבוע שבועי שעה בשעה',
].join(' ')));

/** Words of time, checked by what they say (a day, a part of the day) rather than by being the person's. */
const TIME_WORDS: ReadonlySet<string> = new Set(contentWords([
  'الصبح الصباح صباحا الظهر العصر المسا المساء الليل بليل الليلة الفجر بكرا بكرة اليوم مبارح',
  'الأحد الاحد الاتنين الاثنين التلاتا الثلاثاء الأربعا الأربعاء الاربعاء الخميس الجمعة السبت',
  'morning afternoon evening night tonight noon midnight today tomorrow o\'clock',
  'sunday monday tuesday wednesday thursday friday saturday',
  'בוקר צהריים ערב לילה הלילה היום מחר ראשון שני שלישי רביעי חמישי שישי שבת',
].join(' ')));

/** The words of the person's turns and the list's titles and clashes: what a reason may repeat. */
function groundWords(grounds: ReplyGrounds): string[] {
  return contentWords([
    ...grounds.userTurns,
    ...grounds.items.map((item) => item.title),
    ...grounds.items.flatMap((item) => (item.conflicts ?? []).map((conflict) => conflict.title ?? '')),
  ].join('\n'));
}

function hasConflicts(grounds: ReplyGrounds): boolean {
  return grounds.items.some((item) => (item.conflicts?.length ?? 0) > 0);
}

/**
 * Whether a reason says only what the person said or what the list holds:
 * every hour, part of the day and day in it is one they said (or a clash's);
 * every other word is theirs, a title's, or a word of saying and clashing.
 */
function reasonGrounded(reason: string, grounds: ReplyGrounds): boolean {
  const allowance = chatTimeAllowance(grounds.userTurns, grounds.now, grounds.timezone);
  const clashHours = new Set<number>();
  const days = new Set<string>(allowance.namedDates);
  for (const item of grounds.items) {
    if (item.resolvedDate) days.add(item.resolvedDate);
    for (const conflict of item.conflicts ?? []) {
      const local = localTimeSpecFor(new Date(conflict.startsAt), grounds.timezone);
      if (!local) continue;
      clashHours.add(Number(local.time.slice(0, 2)) % 12);
      days.add(local.date);
    }
  }
  const hourSaid = (hour: number) => allowance.hours.has(hour % 12) || clashHours.has(hour % 12);
  for (const hour of Array.from(statedClockHours(reason))) if (!hourSaid(hour)) return false;
  const part = dayPartHour(reason);
  if (part !== null && !hourSaid(part)) return false;
  if (!allowance.anyDate) {
    const weekday = resolveWeekdayDate(reason, grounds.now, grounds.timezone);
    if (weekday && !days.has(weekday.date)) return false;
    const offset = relativeDayOffset(reason);
    const today = localTimeSpecFor(grounds.now, grounds.timezone)?.date;
    if (offset !== null && today) {
      const [year, month, day] = today.split('-').map(Number) as [number, number, number];
      const named = new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
      if (!days.has(named)) return false;
    }
  }
  const theirs = groundWords(grounds);
  return contentWords(reason)
    .filter((word) => !REASON_WORDS.has(word) && !TIME_WORDS.has(word))
    .every((word) => theirs.some((candidate) => sameWord(word, candidate)));
}

const TRAILING_MARKS = new RegExp('[.!?؟…]+$', 'u');

/** The reason a sentence gives, from its marker to the end of that clause; null when it gives none. */
function reasonOf(sentence: string): string | null {
  const folded = fold(sentence);
  for (const marker of REASON_MARKERS) {
    const match = marker.exec(folded);
    if (!match) continue;
    const rest = folded.slice(match.index + match[0].length);
    const end = REASON_END.exec(rest);
    return (end ? rest.slice(0, end.index) : rest).replace(TRAILING_MARKS, '').trim();
  }
  return null;
}

/* ── what a clash is ───────────────────────────────────────────────── */

/** A sentence saying something clashes, or that the person is busy then. */
const CLASH_WORDS: readonly RegExp[] = [
  foldInjectionPattern(new RegExp(
    '(?<![\\p{L}\\p{M}])[وف]?(?:بيتعارض|يتعارض|بتتعارض|تتعارض|تعارض|متعارض|متعارضة|بيتقاطع|يتقاطع|بتتقاطع|تتقاطع|تقاطع|مشغول|مشغولة)(?![\\p{L}\\p{M}])',
    'u',
  )),
  /\b(?:clash(?:es|ing)?|conflicts?|conflicting|overlaps?|overlapping|busy|double[-\s]?book(?:ed)?)\b/i,
  new RegExp('(?:^|\\s)[ו]?(?:מתנגש|מתנגשת|מתנגשים|התנגשות|חופף|חופפת|חופפים|עסוק|עסוקה|תפוס|תפוסה)(?=\\s|$|[.,!?])', 'u'),
];

const claimsClash = (sentence: string): boolean => CLASH_WORDS.some((pattern) => pattern.test(fold(sentence)));

/** Words quoted in a sentence: «…», "…", “…”. */
const QUOTED = /«([^»]{1,120})»|"([^"]{1,120})"|“([^”]{1,120})”/g;

/**
 * Whether every title a clash sentence quotes is one the list holds — an
 * item's, or a clash's own. The calendar's busy time has none, so a clash
 * sentence that quotes one for it («بيتعارض مع "الجيم"») names a thing the
 * person never had.
 */
function quotesOnlyKnownTitles(sentence: string, grounds: ReplyGrounds): boolean {
  const known = grounds.items.flatMap((item) => [item.title, ...(item.conflicts ?? []).map((conflict) => conflict.title ?? '')])
    .filter(Boolean)
    .map((title) => contentWords(title));
  for (const match of Array.from(sentence.slice(0, CHAT_REPLY_SCAN_LIMIT).matchAll(QUOTED))) {
    const words = contentWords(match[1] ?? match[2] ?? match[3] ?? '');
    if (words.length === 0) continue;
    if (!known.some((title) => words.some((word) => title.some((candidate) => sameWord(word, candidate))))) return false;
  }
  return true;
}

/**
 * The model's reply without a sentence that gives a reason the person never
 * gave, claims a clash when nothing clashes, or offers another time when
 * nothing clashes, or names a clash by a title nothing on the list has. What
 * is left may be empty: the caller then answers with its template.
 */
export function groundedReply(reply: string, grounds: ReplyGrounds): string {
  const clashing = hasConflicts(grounds);
  return sentencesOf(reply).filter((sentence) => {
    const clash = claimsClash(sentence);
    if (!clashing && (clash || offerSentences(sentence).length > 0)) return false;
    if (clash && !quotesOnlyKnownTitles(sentence, grounds)) return false;
    const reason = reasonOf(sentence);
    return reason === null || reasonGrounded(reason, grounds);
  }).join(' ');
}

/* ── naming a clash the reply left out ─────────────────────────────── */

const DAYS: Readonly<Record<ChatLanguage, readonly string[]>> = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  en: ['on Sunday', 'on Monday', 'on Tuesday', 'on Wednesday', 'on Thursday', 'on Friday', 'on Saturday'],
  he: ['ביום ראשון', 'ביום שני', 'ביום שלישי', 'ביום רביעי', 'ביום חמישי', 'ביום שישי', 'בשבת'],
};
const RELATIVE: Readonly<Record<ChatLanguage, readonly [string, string]>> = {
  ar: ['اليوم', 'بكرا'],
  en: ['today', 'tomorrow'],
  he: ['היום', 'מחר'],
};

/** «{day} الساعة {time}», "{day} at {time}", «{day} ב-{time}»; a range for a block with a length of its own. */
const WHEN: Readonly<Record<ChatLanguage, { at: string; range: string }>> = {
  ar: { at: '{day} الساعة {time}', range: '{day} من {start} لـ {end}' },
  en: { at: '{day} at {time}', range: '{day} {start}–{end}' },
  he: { at: '{day} ב-{time}', range: '{day} {start}–{end}' },
};

/** One clash, said: the item, what it lands on, and when; the calendar's busy time without a title. */
const CLASH_SENTENCE: Readonly<Record<ChatLanguage, { named: string; busy: string }>> = {
  ar: {
    named: '«{item}» بيتعارض مع «{other}» {when}.',
    busy: 'تقويمك بيقول إنك مشغول {when}، بنفس وقت «{item}».',
  },
  en: {
    named: '"{item}" clashes with "{other}" {when}.',
    busy: 'Your calendar shows you busy {when}, the same time as "{item}".',
  },
  he: {
    named: '"{item}" מתנגש עם "{other}" {when}.',
    busy: 'לפי היומן, {when} הזמן כבר תפוס — באותו זמן של "{item}".',
  },
};

function clipped(title: string): string {
  const clean = title.replace(/[\u2066-\u2069]/g, '').trim();
  return clean.length > CLASH_TITLE_MAX ? `${clean.slice(0, CLASH_TITLE_MAX - 1)}…` : clean;
}

/** A title in a sentence: isolated in Arabic and Hebrew, so a Latin title does not jump to the line's start. */
function titleIn(language: ChatLanguage, title: string): string {
  return language === 'en' ? clipped(title) : `${FSI}${clipped(title)}${PDI}`;
}

/** A clock in a sentence: left to right in Arabic and Hebrew, as the app's `ltr()` does. */
function clockIn(language: ChatLanguage, clock: string): string {
  return language === 'en' ? clock : `${LRI}${clock}${PDI}`;
}

function dayLabel(language: ChatLanguage, date: string, now: Date, timezone: string): string {
  const today = localTimeSpecFor(now, timezone)?.date;
  if (today) {
    const [year, month, day] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    if (date === today) return RELATIVE[language][0];
    if (date === tomorrow) return RELATIVE[language][1];
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return DAYS[language][new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}

/**
 * When a clash is, in the person's language: its start for something at a
 * time (a commitment, a match), its range for time held for a stretch (a
 * weekly block, the calendar's busy time).
 */
export function clashWhen(language: ChatLanguage, conflict: ConflictLike, now: Date, timezone: string): string {
  const start = localTimeSpecFor(new Date(conflict.startsAt), timezone);
  const end = localTimeSpecFor(new Date(conflict.endsAt), timezone);
  if (!start || !end) return '';
  const day = dayLabel(language, start.date, now, timezone);
  const ranged = conflict.kind === 'weekly' || conflict.kind === 'calendar_busy';
  return ranged
    ? rangeIn(language, day, start.time, end.time)
    : WHEN[language].at.replace('{day}', day).replace('{time}', clockIn(language, start.time));
}

function rangeIn(language: ChatLanguage, day: string, start: string, end: string): string {
  if (language === 'ar') return WHEN.ar.range.replace('{day}', day).replace('{start}', clockIn('ar', start)).replace('{end}', clockIn('ar', end));
  return WHEN[language].range.replace('{day}', day).replace('{start}–{end}', clockIn(language, `${start}–${end}`));
}

/** The sentence that names one clash of one item. */
export function clashSentence(language: ChatLanguage, itemTitle: string, conflict: ConflictLike, now: Date, timezone: string): string {
  const when = clashWhen(language, conflict, now, timezone);
  const table = CLASH_SENTENCE[language];
  const template = conflict.title === null ? table.busy : table.named;
  return template
    .replace('{item}', titleIn(language, itemTitle))
    .replace('{other}', conflict.title === null ? '' : titleIn(language, conflict.title))
    .replace('{when}', when);
}

const CALENDAR_WORD = new RegExp('calendar|تقويم|יומן', 'iu');

/** Whether a reply already names this clash: the other thing's title, or — for busy time — the calendar. */
function mentions(reply: string, conflict: ConflictLike): boolean {
  const folded = fold(reply);
  if (conflict.title === null) return CALENDAR_WORD.test(folded);
  const words = contentWords(conflict.title);
  if (words.length === 0) return folded.includes(fold(conflict.title).trim());
  const said = contentWords(reply);
  return words.some((word) => said.some((candidate) => sameWord(word, candidate)));
}

/** The key a clash is remembered by between turns: which item, on what, when. */
export function clashKey(itemTitle: string, conflict: ConflictLike): string {
  return `${itemTitle}|${conflict.title ?? ''}|${conflict.startsAt}`;
}

/**
 * The reply, with one short sentence for each item's clash it does not name
 * yet (at most `MAX_ADDED_CLASHES`), before its closing question if it ends
 * with one. A clash already on the list the person saw before this message
 * (`alreadyShown`) was said then, and is not said again.
 */
export function withConflictsNamed(
  reply: string,
  items: ReadonlyArray<GroundsItem>,
  context: { language: ChatLanguage; now: Date; timezone: string; alreadyShown?: ReadonlySet<string> },
): string {
  const added: string[] = [];
  // Two cards that land on each other are one clash, said once.
  const pairs = new Set<string>();
  for (const item of items) {
    const conflict = namedClash(item);
    // Another card of the same list is named by any reply that describes the
    // list (audit 2026-10-03 #1): for it, only a reply that says it clashes
    // has named the clash.
    if (!conflict || context.alreadyShown?.has(clashKey(item.title, conflict))) continue;
    if (mentions(reply, conflict) && (!conflict.inProposal || claimsClash(reply))) continue;
    if (conflict.inProposal) {
      const pair = [item.title, conflict.title ?? ''].sort().join('|');
      if (pairs.has(pair)) continue;
      pairs.add(pair);
    }
    added.push(clashSentence(context.language, item.title, conflict, context.now, context.timezone));
    if (added.length >= MAX_ADDED_CLASHES) break;
  }
  if (added.length === 0) return reply;
  const sentences = sentencesOf(reply);
  const last = sentences[sentences.length - 1];
  if (last && /[?؟]/.test(last)) return [...sentences.slice(0, -1), ...added, last].join(' ');
  const ended = !reply.trim() || /[.!?؟…]$/.test(reply.trim()) ? reply.trim() : `${reply.trim()}.`;
  return [ended, ...added].filter(Boolean).join(' ');
}
