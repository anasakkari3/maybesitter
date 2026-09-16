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
 * **Every check here is run in Arabic and Hebrew as well as English, and the
 * ones that read digits are run on digits this product's users actually type.**
 * The first version of this module was neither, and said so in a comment that
 * was wrong in the unsafe direction: JavaScript's `\d` is ASCII-only, so an
 * answer written in Arabic-Indic numerals matched *nothing*, `[].some(...)` was
 * `false`, and a wholly fabricated Arabic sentence — invented count, invented
 * times — was accepted and stored `source: 'model', validated: true`. A guard
 * that cannot see its input fails open while looking strict.
 *
 * Two things close it:
 *
 *   1. `toAsciiDigits` folds Arabic-Indic (U+0660–0669), Extended Arabic-Indic
 *      (U+06F0–06F9) and fullwidth digits to ASCII *before* the clock and count
 *      passes. NFKC does not do this — those code points are separate digits,
 *      not compatibility spellings — so `matchingVariants` never would have.
 *   2. `EXPLANATION_LEXICONS` carries shame, coercion, persistence and §13
 *      patterns per locale, and **model output in a locale that has no entry in
 *      that table is refused outright** (`unsupported_locale`). The union of all
 *      locales' patterns is applied to every answer, so a model replying in
 *      English to an Arabic prompt is still read; but an answer is only
 *      *accepted* in a language this table can read.
 *
 * The Arabic and Hebrew lexicons are authored here rather than translated from
 * the English list word for word: `monitoring` says nothing about `أراقب` or
 * `אעקוב`. They are deliberately written without `\b`, which in JavaScript is
 * defined on `[A-Za-z0-9_]` and therefore fires in the wrong places in both
 * scripts; substring matching also absorbs the Arabic and Hebrew proclitics
 * (`و`, `ب`, `ال`, `ו`, `ש`, `ה`) for free. They over-catch, and over-catching
 * costs the template, which is always true.
 *
 * What is still *not* reached, stated rather than discovered: `CAPITALISED_RUN`
 * is the shape an invented title takes in a cased script, and Arabic and Hebrew
 * have no case. In those locales an invented title is caught only when the
 * model quotes it. A count or a time written as words — `تسع إشيا`,
 * `תשעה דברים`, `nine things`, `at nine` — is not read in any locale: the
 * structural checks read digits. That is a fidelity gap rather than a safety
 * one (the plan screen lists the real items), and it is stated here so nobody
 * mistakes the count check for coverage of it. Neither lexicon is a claim of coverage — a word list never
 * is — and what carries the weight remains the structural checks, which now run
 * in every locale, plus a prompt that is given ids, times and counts and
 * nothing to be judgemental about.
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

/**
 * The same four judgements, in the two languages most of this product's users
 * read.
 *
 * Written as substrings rather than as `\b`-anchored words on purpose — see the
 * header. Each list is short, concrete and answerable: a phrase is here because
 * it is a thing a model actually writes, and an entry that would fire on the
 * templates below would be a bug the locale template tests catch immediately.
 *
 * `en` is referenced, never retyped: `lib/safety/lexicon.ts` is the repository's
 * one copy of the English lists and a second spelling of them here is exactly
 * the drift Sprint 06 forbids.
 */
export interface LocaleLexicon {
  readonly shame: readonly RegExp[];
  readonly coercion: readonly RegExp[];
  readonly persistence: readonly RegExp[];
  readonly prohibited: readonly RegExp[];
}

/** Levantine and standard spellings both, because the prompt asks for Levantine. */
const ARABIC_LEXICON: LocaleLexicon = Object.freeze({
  shame: Object.freeze([
    /كسول|كسلان|كسلانة/,
    /مهمل|إهمال|اهمال/,
    /مقصر|مقصّر/,
    /فشلت|فاشل|فشلك/,
    /خذلت|خيبت|خيّبت/,
    /مخجل|تستحي|عيب عليك/,
    /مذنب|ذنبك|غلطتك|بسببك/,
    /غير منضبط|ما عندك انضباط/,
    /دايما بتنسى|دائما تنسى|دايماً بتنسى/,
    /ما بتلتزم|ما بتكمل أبدا/,
  ]),
  coercion: Object.freeze([
    /ما ?[إا]لك خيار|ما في خيار|ليس لديك خيار|لا خيار/,
    /آخر فرصة|الفرصة الأخيرة|آخر مرة/,
    /إنذار أخير|تحذير أخير/,
    /لازم تعمل|لازم تسوي|لازم تخلص|لازم تنهي|لازم تكمل|يجب عليك|مجبور/,
    /وإلا رح|أو غير هيك/,
  ]),
  persistence: Object.freeze([
    /حفظت|سجلت|سجّلت|خزنت|خزّنت|أنشأت|جدولت|جدولتلك|وثقت|دونت|دوّنت|ضفت|أضفت/,
    /محفوظ|مسجل|مسجّل|متخزن/,
    /رح أتابع|رح أراقب|رح أذكرك|بتابعلك|أراقب|أتتبع|بخلي عيني/,
  ]),
  prohibited: Object.freeze([
    /يعالج|بيعالج|معالجة|علاج/,
    /تشخيص|يشخص|بيشخص/,
    /بيعرفك أكتر|يعرفك أكثر|بعرفك أكتر من حالك/,
    /بيدير حياتك|يدير حياتك|بيمسك حياتك/,
    /بتذكر كل إشي|بيتذكر كل شي|أتذكر كل شيء/,
    /بديل عن حكمك|محل قرارك|بدل قرارك/,
  ]),
});

const HEBREW_LEXICON: LocaleLexicon = Object.freeze({
  shame: Object.freeze([
    /עצלן|עצלנית/,
    /חסר משמעת|חסרת משמעת|חוסר משמעת/,
    /נכשלת|כישלון|כשלת/,
    /אשמתך|באשמתך|זו אשמתך|אתה אשם|את אשמה/,
    /מבייש|תתבייש|בושה/,
    /לא עקבי|לא עקבית/,
    /התחמקת|התחמקות/,
    /איכזבת|אכזבת/,
    /אתה תמיד|את תמיד|אתה אף פעם|את אף פעם/,
  ]),
  coercion: Object.freeze([
    /אין לך ברירה|אין ברירה|ברירה אחרת אין/,
    /הזדמנות אחרונה|צ'אנס אחרון/,
    /אזהרה אחרונה/,
    /אתה חייב|את חייבת|חייב לעשות|חייבת לעשות|חובה עליך|חובה לסיים/,
    /או אחרת|אחרת אפסיק/,
  ]),
  persistence: Object.freeze([
    /שמרתי|רשמתי|יצרתי|קבעתי|תיעדתי|עדכנתי|הוספתי/,
    /שמור אצלי|נשמר ביומן|רשום אצלי/,
    /אעקוב|אנטר|במעקב|אשים עין|אזכיר לך|אשמור לך/,
  ]),
  prohibited: Object.freeze([
    /מטפל ב|טיפול ב|מרפא/,
    /מאבחן|אבחון/,
    /מכיר אותך יותר טוב ממך|יודע עליך יותר ממך/,
    /מנהל את החיים שלך|מנהל לך את החיים/,
    /זוכר הכל|זוכר את הכל/,
    /מחליף את שיקול הדעת שלך/,
  ]),
});

/**
 * The locales whose model output may be shown at all.
 *
 * A locale absent from this table has no lexicon, so none of the four
 * judgements below can see its text — and an answer nothing can read is refused
 * rather than shown. That refusal is the half of this fix that does not depend
 * on anybody's word list being good: adding a fourth language to `UserLocale`
 * without a row here turns the plan explanation back into the template, loudly,
 * instead of silently shipping unvalidated model prose.
 */
export const EXPLANATION_LEXICONS: Readonly<Record<UserLocale, LocaleLexicon>> = Object.freeze({
  en: Object.freeze({
    shame: SHAME_PATTERNS,
    coercion: COERCION_PATTERNS,
    persistence: PERSISTENCE_CLAIM_PATTERNS,
    prohibited: PROHIBITED_CLAIM_PATTERNS,
  }),
  ar: ARABIC_LEXICON,
  he: HEBREW_LEXICON,
});

/** Whether a model may be asked for, and trusted with, this locale at all. */
export function hasExplanationLexicon(locale: unknown): locale is UserLocale {
  return typeof locale === 'string'
    && Object.prototype.hasOwnProperty.call(EXPLANATION_LEXICONS, locale);
}

/**
 * Arabic and Hebrew as they are written, reduced to the spelling the lexicons use.
 *
 * The lexicons are substrings over bare letters, and the first probe of them in
 * the scripts they exist for found every one of these accepted — each a word
 * the lists already carried:
 *
 *   - harakat and Hebrew niqqud (`كَسُول`, `עַצְלָן`), which models do emit,
 *     and which NFKC leaves alone because they are not compatibility forms;
 *   - the tatweel U+0640 (`كسـول`), a letter-stretching character;
 *   - the Arabic letter mark U+061C and the bidi isolates U+2066–2069, which
 *     `safetyContracts`' format-character class does not include;
 *   - alef with hamza or madda (`آخر` typed as `اخر`), alef maqsura for yeh,
 *     and ta marbuta for heh — the spellings Levantine Arabic is actually typed
 *     in, and the ones the lists half-anticipated with `[إا]` and `اهمال`.
 *
 * Marks are removed and letter variants folded to one letter, on the text **and
 * on the patterns** (see `FOLDED`), so an entry written with a hamza still
 * matches text typed without one and the reverse. Hebrew geresh and gershayim
 * are punctuation, not marks, and are kept: the title check reads them as
 * quotation marks.
 *
 * Over-catching is the safe direction here — a refusal costs the template —
 * which is why folding letters together is acceptable in a guard and would not
 * be in, say, a search index.
 */
const SCRIPT_MARKS = /[\u00AD\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u061C\u0640\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function foldScript(text: string): string {
  return text
    .normalize('NFKC')
    .replace(SCRIPT_MARKS, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647');
}

function foldPattern(pattern: RegExp): RegExp {
  return new RegExp(foldScript(pattern.source), pattern.flags);
}

type LexiconKey = keyof LocaleLexicon;

/** Every locale's patterns for one judgement, folded once at load. */
const FOLDED: Readonly<Record<LexiconKey, readonly RegExp[]>> = (() => {
  const keys: LexiconKey[] = ['shame', 'coercion', 'persistence', 'prohibited'];
  const folded = {} as Record<LexiconKey, readonly RegExp[]>;
  for (const key of keys) {
    folded[key] = Object.freeze(Object.values(EXPLANATION_LEXICONS).flatMap((lexicon) => lexicon[key].map(foldPattern)));
  }
  return Object.freeze(folded);
})();

export type ExplanationRejection =
  | 'empty'
  | 'unsupported_locale'
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

/**
 * The same numbers, written in ASCII.
 *
 * Arabic-Indic `٠١٢٣٤٥٦٧٨٩` (U+0660–0669), Extended Arabic-Indic `۰۱۲۳۴۵۶۷۸۹`
 * (U+06F0–06F9) and fullwidth `０１２３４５６７８９`, plus the fullwidth colon, so
 * that `٠٩:٠٠` is read as a clock time and `٤٢` is read as a count. Every
 * substitution is one code point for one code point, which is what lets the
 * offsets of a match in the folded text still index the original.
 *
 * NFKC — which `matchingVariants` already applies for the lexical checks — folds
 * the fullwidth forms and **not** the two Arabic sets: those are separate
 * digits, not compatibility spellings of ASCII ones. That is precisely why the
 * structural checks needed their own fold and did not get one.
 */
export function toAsciiDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9\uFF10-\uFF19\uFF1A]/g, (character) => {
    const code = character.codePointAt(0)!;
    if (code === 0xFF1A) return ':';
    const base = code >= 0xFF10 ? 0xFF10 : code >= 0x06F0 ? 0x06F0 : 0x0660;
    return String(code - base);
  });
}

const CLOCK = /\b([01]?[0-9]|2[0-3]):([0-5][0-9])\b/g;
/**
 * Quotation marks, including the ones Hebrew is quoted in: gershayim U+05F4 and
 * the low-high pair „“. Without them an invented title in a Hebrew sentence was
 * accepted as long as it was quoted the way Hebrew quotes.
 */
const QUOTED = /["“”«»'״„‟＂]([^"“”«»'״„‟＂\n]{2,80})["“”«»'״„‟＂]/g;
/** Two or more adjacent Capitalised Latin words: the shape an invented title takes. */
const CAPITALISED_RUN = /\b[A-Z][a-z'’]+(?:\s+[A-Z][a-z'’]+)+/g;
/** Any run of digits: `12345` is not less of a count claim for being long. */
const INTEGER = /\b\d+\b/g;

function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s‏‎]+/g, ' ').trim();
}

/** True when the fragment is part of some title the plan actually placed. */
function matchesSomeTitle(fragment: string, titles: readonly string[]): boolean {
  const needle = normalise(foldScript(fragment));
  if (needle.length < 2) return true;
  return titles.some((title) => {
    const hay = normalise(foldScript(title));
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
  // Before anything else: an answer in a language none of the lists below can
  // read is refused whatever it says. Every other check that follows would
  // return "clean" on it, and "clean" would be a statement about this module's
  // vocabulary rather than about the sentence.
  if (!hasExplanationLexicon(facts.locale)) reasons.push('unsupported_locale');
  if (text.length > MAX_EXPLANATION_CHARS) reasons.push('too_long');

  // Digits first, and once: every structural check below reads the folded text,
  // so `٠٩:٠٠` is a clock time and `٤٢` is a count. Folding is one code point
  // for one, so `match.index` still indexes the same position in either string.
  // Marks and invisible characters go first: `٠١<RLM>:٠٢` is a clock time to a
  // reader, and must be one to the pattern. Removal is not one-for-one, which
  // is fine — every offset below indexes `scanned`, never `text`.
  const scanned = toAsciiDigits(foldScript(text));

  const allowed = new Set(facts.allowedTimes);
  const times = Array.from(scanned.matchAll(CLOCK), (match) => `${match[1].padStart(2, '0')}:${match[2]}`);
  if (times.some((time) => !allowed.has(time))) reasons.push('time_not_in_plan');

  const quoted = Array.from(scanned.matchAll(QUOTED), (match) => match[1]);
  // A capitalised run that opens the text or a sentence is ordinary English
  // ("Today Nothing…"), so only runs that start mid-sentence are treated as a
  // claimed title.
  const capitalised = Array.from(scanned.matchAll(CAPITALISED_RUN))
    .filter((match) => {
      const before = scanned.slice(0, match.index ?? 0);
      return before.trim() !== '' && !/[.!?\n]\s*$/.test(before);
    })
    .map((match) => match[0]);
  if ([...quoted, ...capitalised].some((fragment) => !matchesSomeTitle(fragment, facts.titles))) {
    reasons.push('unknown_title');
  }

  // Clock times and quoted titles are removed first: `09:00` is not a claim
  // about how many things there are, and a title may legitimately contain a
  // number ("Pay the 2 invoices").
  const countable = scanned.replace(CLOCK, ' ').replace(QUOTED, ' ');
  const numbers = Array.from(countable.matchAll(INTEGER), (match) => Number(match[0]));
  if (numbers.some((value) => value !== facts.scheduledCount && value !== facts.unscheduledCount)) {
    reasons.push('count_mismatch');
  }

  // Every locale's patterns on every answer, not only the account's: a model
  // asked for Arabic that shames in English has still shamed. The account's
  // locale decides whether the answer may be *accepted* (above), not which
  // lists get to look at it.
  const lexical = foldScript(text);
  if (matchesAny(lexical, FOLDED.shame)) reasons.push('shame');
  if (matchesAny(lexical, FOLDED.coercion)) reasons.push('coercion');
  if (matchesAny(lexical, FOLDED.persistence)) reasons.push('persistence_claim');
  if (matchesAny(lexical, FOLDED.prohibited)) reasons.push('prohibited_claim');

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
