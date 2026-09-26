/**
 * Steps for a goal the sentence does not already split (CL3).
 *
 * ── Why this exists next to the decomposition engine ────────────
 *
 * The engine reads steps *out of a sentence*: "build the landing page, then
 * set up payments" is two clauses, and every step it offers is grounded in a
 * span of the text. That is the right discipline for a commitment and the
 * wrong one for a goal. "أطلق تطبيقي على المتجر قبل نهاية السنة" is one clause
 * with no connective, so the engine answers `atomic` and the review screen had
 * nothing to show but the goal itself (first phone run, shot 73). And a model
 * behind the engine could not help: a goal's steps are *not in the sentence*,
 * so they are inferred by definition, and the engine refuses a proposal whose
 * steps are mostly inferred (`model_output_invalid:mostly_inferred`).
 *
 * So a goal gets its steps from one of three places, in order — the goal
 * planner model (validated here), the engine's sentence split, or the
 * deterministic starting point for the goal's shape below — and never from
 * none of them.
 *
 * ── What is pure here ───────────────────────────────────────────
 *
 * Everything. The model call lives in `lib/services/mobile/goalStepModel.ts`,
 * behind the consent gate and the cost guard; this module only judges what
 * came back and builds the fallback. It reads no clock and writes nothing,
 * because it is in the import closure of generation, which is held to that by
 * `tests/goalGraph/goalGraphBoundaries.test.ts`.
 */
import {
  GOAL_STEP_SUGGESTED_WHEN,
  type GoalStepSuggestedKind,
  type GoalStepSuggestedWhen,
} from '../../src/contracts/v1/goalGraphContracts';
import { docIdForKey } from '../storage/paths';

/**
 * Which wording the planner model is asked with. Stored beside its answer.
 *
 * v2 (CL3 round 1): Levantine few-shot examples, and a register check that
 * asks once more when the Arabic comes back formal.
 * v3 (CL3 round 2): a habit's title names no frequency or duration, and the
 * examples say no weekday.
 */
export const GOAL_STEPS_PROMPT_VERSION = 'goal-steps-v3';

/** Fewer than this many usable steps is not a plan; the fallback is used. */
export const GOAL_STEPS_MIN = 2;
/** More than this is a list nobody reviews; the rest are trimmed. */
export const GOAL_STEPS_MAX = 6;
/** A step is a line on a phone. Longer is a paragraph, not a step. */
export const GOAL_STEP_TITLE_MAX = 90;
const GOAL_STEP_TITLE_MIN = 4;
/** A draft that returns more items than this is not answering the question. */
const GOAL_STEPS_RAW_LIMIT = 20;

export type GoalStepLanguage = 'ar' | 'he' | 'en';

/** One step as the planner (model or template) proposes it. */
export interface GoalStepDraft {
  /** Content-derived, so the same step keeps its link across regenerations. */
  readonly stepId: string;
  readonly title: string;
  readonly suggestedAs: GoalStepSuggestedKind;
  readonly suggestedWhen: GoalStepSuggestedWhen | null;
}

export interface GoalStepValidation {
  readonly steps: readonly GoalStepDraft[];
  /** Why the draft was not usable, as a code; null when it was. */
  readonly reason: string | null;
  /** How many items were dropped, by reason code. For the log, never the text. */
  readonly dropped: Readonly<Record<string, number>>;
}

/**
 * The shape the model is asked for, in JSON Schema (run through
 * `toVertexSchema` by the caller). `when: 'none'` rather than a nullable
 * string, because a closed enum is the one thing structured output reliably
 * holds a model to.
 */
export const GOAL_STEPS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['commitment', 'habit'] },
          when: { type: 'string', enum: ['today', 'this_week', 'this_month', 'none'] },
        },
        required: ['title', 'kind', 'when'],
      },
    },
  },
  required: ['steps'],
} as const);

const ARABIC_LETTER = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF]/g;
const HEBREW_LETTER = /[\u05D0-\u05EA]/g;
const LATIN_LETTER = /[A-Za-z]/g;

function countOf(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * The language the steps should be written in: the script the goal is
 * actually typed in, not the interface language it was saved under.
 *
 * The memory record's `language` is the app's language at the moment of
 * saving, so an English sentence typed on an Arabic phone is filed `ar`.
 * Answering a goal in a language it was not written in is the one mistake a
 * person reading their own goal notices first.
 */
export function goalStepLanguageOf(goalText: string, recorded: string): GoalStepLanguage {
  const arabic = countOf(goalText, ARABIC_LETTER);
  const hebrew = countOf(goalText, HEBREW_LETTER);
  const latin = countOf(goalText, LATIN_LETTER);
  const top = Math.max(arabic, hebrew, latin);
  if (top === 0) return recorded === 'ar' || recorded === 'he' ? recorded : 'en';
  if (arabic === top && arabic > hebrew && arabic > latin) return 'ar';
  if (hebrew === top && hebrew > arabic && hebrew > latin) return 'he';
  if (latin === top && latin > arabic && latin > hebrew) return 'en';
  return recorded === 'ar' || recorded === 'he' ? recorded : 'en';
}

/**
 * The comparison key for a title: case, diacritics, tatweel, punctuation and
 * spacing removed. Two titles with one key are one step.
 */
export function goalStepKeyOf(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640\u0591-\u05C7]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^0-9A-Za-z\u00C0-\u024F\u05D0-\u05EA\u0621-\u064A\u0660-\u0669\u066E-\u06D3\u06FA-\u06FF]+/g, ' ')
    .trim();
}

/**
 * `m…` for a model step, `t…` for a template one: short, stable, and derived
 * from the step's own words.
 *
 * Positional ids (`s1`, `s2`) are right for the engine, whose steps are
 * clauses of one fixed sentence. A model's steps are not: generation 2 may put
 * a different step first, and a link keyed on `step.s1` would then claim the
 * new step was already confirmed — hiding it, and refusing to create it. A key
 * from the step's words carries a link only to the same step.
 */
export function goalStepIdFor(source: 'model' | 'template', title: string): string {
  return `${source === 'model' ? 'm' : 't'}${docIdForKey(`goal-step:${goalStepKeyOf(title)}`).slice(0, 12)}`;
}

/** Leading bullets, numbering and quote marks a model likes to add. */
function cleanTitle(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-\u2013\u2014\u2022*\u00B7]|\(?[0-9\u0660-\u0669]+[.)\-:]|step\s*[0-9]+[.:)]?)\s*/i, '')
    .replace(/[.。؛;]+$/, '')
    .trim();
}

/** Things a step never contains, whatever the model thought. */
const UNSAFE = [
  /https?:|www\.|\.com\b/i,
  /\S+@\S+\.\S+/,
  /[0-9\u0660-\u0669]{6,}/,
  /BEGIN_UNTRUSTED|END_UNTRUSTED|system prompt|ignore (all |the )?(previous|above)/i,
  /[<>{}[\]`\\]/,
];

/*
 * ── No dates in a title (CL3 round 2, review I-2) ────────────────
 *
 * #526 forbids invented deadlines, and the structured fields already have
 * nowhere to put one — but a title is free text, and it becomes the
 * commitment's title verbatim on confirm. "Submit the build by March 3" would
 * put a date in somebody's list that they never set. So a step whose words
 * name a date, a clock time, a month, a weekday, or "by/before/قبل/لحد/עד"
 * followed by a time word is dropped as `dated`. Timing belongs in
 * `suggestedWhen`, which is a hint and schedules nothing.
 *
 * Written without the `u` flag or look-behind, to stay inside the compile
 * target; a letter boundary is "not preceded by a letter" spelled as a group.
 */
const DIGIT = '[0-9٠-٩۰-۹]';
const NOT_AR = '(?:^|[^\u0621-\u064A])';
const AR_END = '(?![\u0621-\u064A])';
const AR_PREFIX = '[وفبل]?(?:ال)?';
const AR_MONTHS = [
  'كانون', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين',
  'يناير', 'فبراير', 'مارس', 'أبريل', 'إبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
].join('|');
const AR_WEEKDAYS = 'السبت|الأحد|الاحد|الاثنين|الإثنين|التنين|الثلاثاء|التلاتا|الأربعاء|الاربعا|الخميس|الجمعة|الجمعه';
/** قبل، لحد، لحتى، لغاية، حتى، بحلول، بآخر، آخر، بنهاية، نهاية، خلال */
const AR_BY = 'قبل|لحد|لحتى|لغاية|حتى|بحلول|بآخر|آخر|بنهاية|نهاية|خلال';
/** الشهر، الأسبوع، الجمعة (week), السنة، بكرا، بكرة، اليوم، الصيف، الشتا، العيد */
const AR_TIME_WORDS = 'الشهر|الأسبوع|الاسبوع|الجمعة|السنة|السنه|بكرا|بكرة|اليوم|الصيف|الشتا|العيد|هالشهر|هالأسبوع|هالجمعة';
const HE_MONTHS = 'ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר';
const HE = 'א-ת';
const EN_MONTHS = 'January|February|March|April|June|July|August|September|Sept|October|November|December|Jan|Feb|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const EN_WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

const DATED: readonly RegExp[] = [
  // 12/10, 3.4, 2027-01-05, ١٥/٣ — and a clock time, 5:30, ٥:٣٠.
  new RegExp(`${DIGIT}{1,4}\\s*[/.\\-:]\\s*${DIGIT}{1,4}`),
  // 5pm, 10 am, ٥ الصبح is fine but «الساعة ٥» is a time.
  new RegExp(`${DIGIT}\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)(?![a-z])`, 'i'),
  new RegExp(`الساعة\\s*${DIGIT}`),
  new RegExp(`ב?שעה\\s*${DIGIT}`),
  // Month names. "May" only beside a number, so the modal verb is left alone.
  new RegExp(`\\b(?:${EN_MONTHS})\\b`),
  new RegExp(`\\bMay\\s+${DIGIT}|${DIGIT}\\s+May\\b`),
  new RegExp(`${NOT_AR}${AR_PREFIX}(?:${AR_MONTHS})${AR_END}`),
  new RegExp(`(?:^|[^${HE}])[בלומה]?(?:${HE_MONTHS})(?![${HE}])`),
  // Weekdays.
  new RegExp(`\\b(?:${EN_WEEKDAYS})\\b`, 'i'),
  new RegExp(`${NOT_AR}[وفبل]?(?:يوم\\s+)?(?:${AR_WEEKDAYS})${AR_END}`),
  new RegExp(`יום\\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|(?:^|[^${HE}])[בלומה]?שבת(?![${HE}])`),
  // "by / before / until" + a time word or a number.
  new RegExp(`\\b(?:by|before|until|till|no later than|due)\\s+(?:the\\s+)?(?:end\\s+of\\s+(?:the\\s+)?)?(?:tomorrow|tonight|today|next|this|week|month|year|weekend|noon|midnight|${DIGIT})`, 'i'),
  new RegExp(`${NOT_AR}(?:${AR_BY})\\s+(?:(?:آخر|نهاية)\\s+)?(?:${AR_TIME_WORDS}|${DIGIT})`),
  new RegExp(`(?:^|[^${HE}])(?:עד|לפני|בתוך|תוך)\\s+(?:סוף\\s+)?(?:מחר|הערב|השבוע|החודש|השנה|סוף|${DIGIT})`),
];

/** True when a step's words name a date, a time, or a deadline. */
export function namesADate(title: string): boolean {
  return DATED.some((pattern) => pattern.test(title));
}

/**
 * Advice rather than a step. Matched on the whole key, so a real step that
 * happens to contain "start" is untouched; what is refused is a step that is
 * nothing *but* the encouragement.
 */
const GENERIC_KEYS: ReadonlySet<string> = new Set([
  'get started', 'start', 'start now', 'make a plan', 'plan it', 'plan ahead', 'set a goal', 'work on it',
  'work on the goal', 'work on your goal', 'stay motivated', 'stay focused', 'keep going', 'do your best',
  'be consistent', 'think about it', 'believe in yourself', 'track your progress', 'take action',
  'ابدا', 'ابدا هلق', 'خطط', 'خطط للهدف', 'اعمل خطه', 'اشتغل عليه', 'اشتغل على الهدف', 'خليك متحمس',
  'حافظ على الحماس', 'كون ملتزم', 'خليك ملتزم', 'فكر فيه', 'تابع تقدمك', 'لا تستسلم',
  'להתחיל', 'תתחיל', 'לתכנן', 'לעבוד על המטרה', 'להישאר ממוקד', 'להתמיד', 'לא לוותר',
]);

/**
 * Constructions spoken Levantine does not use, so a step containing one was
 * written in formal Arabic (MSA).
 *
 * The first six mirror the bundle register check CL2a added to
 * `mobile/src/i18n/__tests__/arabicRegister.test.ts`, so the steps a model
 * writes are held to the same line as the copy the app ships. The rest are
 * the formal-instruction shapes a model reaches for when it writes a to-do:
 * «قم بـ», «يجب», «ينبغي», «عليك أن», «كيفية», «لكي».
 *
 * Deliberately light. It catches the obvious, not the merely neutral: «حدّد»
 * and «اكتب» are imperatives in both registers and pass.
 */
export const ARABIC_FORMAL_MARKERS: readonly RegExp[] = Object.freeze([
  /(^|[\s«({])[\u0648\u0641]?(\u0644\u0645|\u0644\u0646|\u0633\u0648\u0641|\u0644\u064A\u0633|\u0644\u062F\u064A\u0646\u0627|\u0644\u062F\u064A\u0643|\u0644\u062F\u064A\u0647)\s/,
  /(^|[\s«({])[\u0648\u0641]?(\u0647\u0630\u0627|\u0647\u0630\u0647|\u0627\u0644\u0630\u064A|\u0627\u0644\u062A\u064A|\u0627\u0644\u0630\u064A\u0646)([\s.\u060C\u061F]|$)/,
  /(^|[\s«({])[\u0648\u0641]?[\u064A\u062A]\u064F/,
  /(^|\s)[\u0648\u0641]?(\u064A\u062A\u0645|\u0633\u064A\u062A\u0645|\u062A\u0645)\s/,
  /(^|[\s«({])\u062C\u0627\u0631\u064A\s/,
  /(\u0627\u062B\u0646\u0627\u0646|\u0627\u062B\u0646\u062A\u0627\u0646|\u0634\u064A\u0626\u0627\u0646|\u0634\u064A\u0626\u064B\u0627)/,
  /(^|[\s«({])[\u0648\u0641]?\u0642\u064F?\u0645\s+\u0628/,
  /(^|[\s«({])[\u0648\u0641]?(\u064A\u062C\u0628|\u064A\u0646\u0628\u063A\u064A|\u0639\u0644\u064A\u0643\s+\u0623\u0646|\u0643\u064A\u0641\u064A\u0629|\u0644\u0643\u064A)([\s.\u060C]|$)/,
]);

/** True when an Arabic step reads as formal Arabic rather than spoken. */
export function hasFormalArabic(title: string): boolean {
  return ARABIC_FORMAL_MARKERS.some((pattern) => pattern.test(title));
}

function scriptFits(title: string, language: GoalStepLanguage): boolean {
  const arabic = countOf(title, ARABIC_LETTER);
  const hebrew = countOf(title, HEBREW_LETTER);
  const latin = countOf(title, LATIN_LETTER);
  const total = arabic + hebrew + latin;
  if (total === 0) return false;
  const own = language === 'ar' ? arabic : language === 'he' ? hebrew : latin;
  // A product name in Latin letters inside an Arabic step is normal
  // ("افتح حساب مطوّر على App Store"); a step mostly in another script is not
  // in the goal's language.
  return own * 2 >= total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Judges a planner model's answer. Refuses rather than repairs, except for the
 * cosmetic: bullets, numbering and trailing full stops are removed, and
 * anything beyond `GOAL_STEPS_MAX` is trimmed.
 *
 * Every field is read once into a fresh object, for the reason the
 * decomposition engine's `normaliseDraft` records: the answer is untrusted
 * data, and a value validated as one thing must not be used as another.
 */
export function validateGoalStepDraft(
  raw: unknown,
  context: { readonly goalText: string; readonly language: GoalStepLanguage },
): GoalStepValidation {
  const dropped: Record<string, number> = {};
  const drop = (code: string): void => { dropped[code] = (dropped[code] ?? 0) + 1; };
  const refuse = (reason: string): GoalStepValidation => Object.freeze({ steps: Object.freeze([]), reason, dropped: Object.freeze(dropped) });

  let items: unknown[];
  try {
    if (!isRecord(raw)) return refuse('model_output_invalid:malformed');
    const steps = raw.steps;
    if (!Array.isArray(steps) || steps.length > GOAL_STEPS_RAW_LIMIT) return refuse('model_output_invalid:malformed');
    items = [...steps];
  } catch {
    return refuse('model_output_invalid:malformed');
  }
  if (items.length === 0) return refuse('model_declined');

  const goalKey = goalStepKeyOf(context.goalText);
  const seen = new Set<string>();
  const accepted: GoalStepDraft[] = [];
  for (const item of items) {
    if (!isRecord(item)) { drop('malformed'); continue; }
    const rawTitle = item.title;
    const kind = item.kind;
    const when = item.when;
    if (typeof rawTitle !== 'string' || rawTitle.length > GOAL_STEP_TITLE_MAX * 4) { drop('malformed'); continue; }
    if (kind !== 'commitment' && kind !== 'habit') { drop('malformed'); continue; }
    if (when !== 'none' && !(GOAL_STEP_SUGGESTED_WHEN as readonly unknown[]).includes(when)) { drop('malformed'); continue; }

    const title = cleanTitle(rawTitle);
    const length = Array.from(title).length;
    if (length < GOAL_STEP_TITLE_MIN || length > GOAL_STEP_TITLE_MAX) { drop('length'); continue; }
    if (UNSAFE.some((pattern) => pattern.test(title))) { drop('unsafe'); continue; }
    if (!scriptFits(title, context.language)) { drop('language'); continue; }
    const key = goalStepKeyOf(title);
    if (key.split(' ').length < 2 || GENERIC_KEYS.has(key)) { drop('generic'); continue; }
    // The goal restated is not a step towards it.
    if (key === goalKey) { drop('restates_goal'); continue; }
    if (namesADate(title)) { drop('dated'); continue; }
    if (seen.has(key)) { drop('duplicate'); continue; }
    seen.add(key);
    accepted.push(Object.freeze({
      stepId: goalStepIdFor('model', title),
      title,
      suggestedAs: kind,
      // A habit repeats; "start it today" is the cadence question in disguise,
      // and the cadence is the person's to state.
      suggestedWhen: kind === 'habit' || when === 'none' ? null : when as GoalStepSuggestedWhen,
    }));
  }

  const steps = accepted.slice(0, GOAL_STEPS_MAX);
  if (accepted.length > GOAL_STEPS_MAX) dropped.trimmed = accepted.length - GOAL_STEPS_MAX;
  if (steps.length < GOAL_STEPS_MIN) return refuse('model_output_invalid:too_few');
  return Object.freeze({ steps: Object.freeze(steps), reason: null, dropped: Object.freeze(dropped) });
}

/* ── The deterministic starting point ─────────────────────────────── */

/** "…by the end of the year", in the three languages. Where the deadline starts. */
const DATED_GOAL = {
  ar: /(?:^|\s)(?:قبل|لحد|لحتى|لغاية|بحلول|خلال|بنهاية|بآخر|نهاية)(?=\s|$)/,
  he: /(?:^|\s)(?:עד|לפני|בתוך|תוך|בסוף|סוף)(?=\s|$)/,
  en: /\b(?:by|before|until|within|dead-?line)\b|\bend of\b/i,
} as const;

/** Goals that are a practice rather than a delivery. */
const RECURRING = {
  ar: /(?:اتعلم|أتعلم|تعلم|تعلّم|اتمرن|أتمرن|تمرين|رياضة|رياضه|نادي|جيم|اقرأ|أقرأ|قراءة|كل يوم|كل أسبوع|يومي|أمارس|مارس|احفظ|أحفظ)/,
  he: /(?:ללמוד|לומד|להתאמן|אימון|ספורט|לקרוא|קריאה|כל יום|כל שבוע|לתרגל)/,
  en: /\b(?:learn|learning|practi[cs]e|exercise|workout|gym|run|running|read|reading|daily|every day|each week|weekly|study)\b/i,
} as const;

type GoalShape = 'dated' | 'recurring' | 'open';

interface TemplateStep {
  readonly title: string;
  readonly suggestedAs: GoalStepSuggestedKind;
  readonly suggestedWhen: GoalStepSuggestedWhen | null;
}

const TEMPLATES: Readonly<Record<GoalStepLanguage, Readonly<Record<GoalShape, readonly TemplateStep[]>>>> = {
  ar: {
    dated: [
      { title: 'قسّم «{goal}» لتلات مراحل، ولكل مرحلة موعد', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'حدّد أول مرحلة من «{goal}» وشو لازم يخلص فيها', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'اشتغل على «{goal}» كم مرة بالأسبوع', suggestedAs: 'habit', suggestedWhen: null },
    ],
    recurring: [
      { title: 'جهّز اللي بتحتاجه لـ«{goal}»', suggestedAs: 'commitment', suggestedWhen: 'today' },
      { title: 'خصّص وقت لـ«{goal}» كم مرة بالأسبوع', suggestedAs: 'habit', suggestedWhen: null },
      { title: 'حدّد كيف بتعرف إنك تقدّمت بـ«{goal}» بعد شهر', suggestedAs: 'commitment', suggestedWhen: 'this_month' },
    ],
    open: [
      { title: 'اكتب شو يعني إنك خلّصت «{goal}»', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'اختار أول خطوة صغيرة لـ«{goal}» واشتغل عليها ربع ساعة', suggestedAs: 'commitment', suggestedWhen: 'today' },
      { title: 'اشتغل على «{goal}» شوي كم مرة بالأسبوع', suggestedAs: 'habit', suggestedWhen: null },
    ],
  },
  he: {
    dated: [
      { title: 'לחלק את "{goal}" לשלושה שלבים, עם תאריך לכל שלב', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'לבחור את השלב הראשון של "{goal}" ומה סוגר אותו', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'לעבוד על "{goal}" כמה פעמים בשבוע', suggestedAs: 'habit', suggestedWhen: null },
    ],
    recurring: [
      { title: 'להכין את מה שצריך בשביל "{goal}"', suggestedAs: 'commitment', suggestedWhen: 'today' },
      { title: 'לפנות זמן ל"{goal}" כמה פעמים בשבוע', suggestedAs: 'habit', suggestedWhen: null },
      { title: 'להחליט איך נראית התקדמות ב"{goal}" בעוד חודש', suggestedAs: 'commitment', suggestedWhen: 'this_month' },
    ],
    open: [
      { title: 'לכתוב מה זה אומר לסיים את "{goal}"', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'לבחור צעד ראשון קטן ל"{goal}" ולעבוד עליו רבע שעה', suggestedAs: 'commitment', suggestedWhen: 'today' },
      { title: 'להקדיש קצת זמן ל"{goal}" כמה פעמים בשבוע', suggestedAs: 'habit', suggestedWhen: null },
    ],
  },
  en: {
    dated: [
      { title: 'Split “{goal}” into three stages, each with a date', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'Pick the first stage of “{goal}” and what finishes it', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'Work on “{goal}” a few times a week', suggestedAs: 'habit', suggestedWhen: null },
    ],
    recurring: [
      { title: 'Get what you need for “{goal}” ready', suggestedAs: 'commitment', suggestedWhen: 'today' },
      { title: 'Make time for “{goal}” a few times a week', suggestedAs: 'habit', suggestedWhen: null },
      { title: 'Decide what a month of progress on “{goal}” looks like', suggestedAs: 'commitment', suggestedWhen: 'this_month' },
    ],
    open: [
      { title: 'Write down what done looks like for “{goal}”', suggestedAs: 'commitment', suggestedWhen: 'this_week' },
      { title: 'Pick one small first step for “{goal}” and give it 15 minutes', suggestedAs: 'commitment', suggestedWhen: 'today' },
      { title: 'Give “{goal}” a little time a few times a week', suggestedAs: 'habit', suggestedWhen: null },
    ],
  },
};

/** How much of the goal a template step quotes. The rest is on the screen above. */
const QUOTED_GOAL_MAX = 40;

/**
 * The goal as a template step quotes it: without its deadline ("…before the
 * end of the year" is the reason for the steps, not part of their name), and
 * short enough to read in a list.
 */
function quotedGoal(goalText: string, language: GoalStepLanguage, shape: GoalShape): string {
  let text = goalText.replace(/\s+/g, ' ').trim();
  if (shape === 'dated') {
    const match = DATED_GOAL[language].exec(text);
    if (match && match.index > 0) text = text.slice(0, match.index).trim();
  }
  text = text.replace(/[\s.,،؛:!?؟\-–—]+$/, '');
  const characters = Array.from(text);
  if (characters.length <= QUOTED_GOAL_MAX) return text;
  const cut = characters.slice(0, QUOTED_GOAL_MAX).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > QUOTED_GOAL_MAX / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

function shapeOf(goalText: string, language: GoalStepLanguage): GoalShape {
  if (DATED_GOAL[language].test(goalText)) return 'dated';
  if (RECURRING[language].test(goalText)) return 'recurring';
  return 'open';
}

/**
 * A concrete first move for any goal, when nothing better is available.
 *
 * The model may be off (no consent, no provider, over a cap), and the
 * sentence may not split. Neither is a reason to show a person an empty
 * screen under a button they pressed: a goal with a deadline gets "break it
 * into stages" and "pick the first one"; a practice gets a standing weekly
 * slot; anything else gets "say what done looks like" and a fifteen-minute
 * first step. Each quotes the goal, so a step confirmed into a commitment
 * still says what it is for when it turns up in a list on its own.
 *
 * A habit template names no count and no duration ("a few times a week"):
 * the review screen preselects a cadence the person then changes, and a
 * title that said "an hour, once a week" would contradict the 3×30 it opens
 * on (CL3 round 2, review M-2).
 */
export function templateGoalSteps(goalText: string, language: GoalStepLanguage): readonly GoalStepDraft[] {
  const shape = shapeOf(goalText, language);
  const goal = quotedGoal(goalText, language, shape);
  return Object.freeze(TEMPLATES[language][shape].map((template) => {
    const title = template.title.replace('{goal}', goal);
    return Object.freeze({
      stepId: goalStepIdFor('template', title),
      title,
      suggestedAs: template.suggestedAs,
      suggestedWhen: template.suggestedWhen,
    });
  }));
}
