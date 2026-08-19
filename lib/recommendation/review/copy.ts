/**
 * Every human-readable string the recommendation review surface emits.
 *
 * Separate from `present.ts` for one reason that matters and one that does not.
 * The one that matters: **no string in this file is assembled from input.** Each
 * is selected by a closed code — a reason code, an action kind, a locale — so
 * there is no path by which a commitment title, a `commitmentId`, a `proposalId`
 * or an evidence `nodeId` reaches rendered text. Sprint 07's recorded leak was a
 * detail string reading `working window call-dr.cohen-about-the-biopsy`, which
 * passed a test that checked only that titles were absent; a copy table with no
 * interpolation at all cannot produce that line, and the test that walks this
 * table for template placeholders is cheap because the table is one object.
 *
 * The one that does not matter much: `present.ts` stays readable.
 *
 * The tables are typed as `Record<ReviewLocale, Record<Code, string>>` over #33's
 * frozen code unions, so adding a reason code to `recommendationContracts.ts`
 * without adding copy for it in all three locales is a compile error rather than
 * a blank line on screen. That is the same device `LIFE_STATE_SOURCE_FIELDS` uses
 * to keep its coverage assertion honest.
 *
 * The wording follows `NEXT_STEP_PRODUCT_POLICY`: no command language, no guilt
 * language. An option is described (`"Doing this now"`), not ordered
 * (`"Do this now"`), because a proposal that reads as an instruction is the
 * failure mode the whole review interaction exists to avoid.
 */

import type {
  ConfidenceBand,
  ExclusionReasonCode,
  OptionSet,
  RecommendationDecisionVerdict,
  RecommendedAction,
  TrustedSource,
  SupportReasonCode,
  WithholdingReasonCode,
} from '../../../src/contracts/v1/recommendationContracts';
import type { NothingToReviewCause, ReviewLocale } from './reviewContract';

type ByLocale<T extends string> = Readonly<Record<ReviewLocale, Readonly<Record<T, string>>>>;

/* ── Chrome ──────────────────────────────────────────────────────── */

export interface ReviewChromeCopy {
  /** Heading for an attributed review. */
  readonly heading: string;
  /** Heading for a blind review — never names the reviewer's own state. */
  readonly headingBlind: string;
  readonly headingNothing: string;
  readonly whyHeading: string;
  readonly leadHeading: string;
  readonly slotsHeading: string;
  readonly alternativesHeading: string;
  readonly excludedHeading: string;
  readonly confirmNotice: string;
  readonly confirmPrompt: string;
  readonly confirmButton: string;
  readonly cancelButton: string;
  readonly announceConfirmed: string;
  readonly announceRecorded: string;
  readonly basisPrefix: string;
  readonly basisSeparator: string;
  readonly basisConjunction: string;
  readonly basisSuffix: string;
}

export const REVIEW_CHROME: Readonly<Record<ReviewLocale, ReviewChromeCopy>> = Object.freeze({
  en: Object.freeze({
    heading: 'A possible next move',
    headingBlind: 'A proposal to review',
    headingNothing: 'Nothing to review',
    whyHeading: 'Why this now',
    leadHeading: 'Suggested',
    slotsHeading: 'Proposals to review',
    alternativesHeading: 'Other options',
    excludedHeading: 'What was ruled out',
    confirmNotice: 'Nothing is saved until you confirm.',
    confirmPrompt: 'Confirm to continue. Nothing has been saved yet.',
    confirmButton: 'Confirm',
    cancelButton: 'Back',
    announceConfirmed: 'Confirmed.',
    announceRecorded: 'Recorded. Nothing was saved.',
    basisPrefix: 'Based on ',
    basisSeparator: ', ',
    basisConjunction: ' and ',
    basisSuffix: '.',
  }),
  ar: Object.freeze({
    heading: 'خطوة تالية محتملة',
    headingBlind: 'اقتراح للمراجعة',
    headingNothing: 'لا يوجد ما يُراجَع',
    whyHeading: 'لماذا هذا الآن',
    leadHeading: 'المُقترَح',
    slotsHeading: 'مقترحات للمراجعة',
    alternativesHeading: 'خيارات أخرى',
    excludedHeading: 'ما جرى استبعاده',
    confirmNotice: 'لا يُحفظ شيء حتى تؤكّد.',
    confirmPrompt: 'أكّد للمتابعة. لم يُحفظ شيء بعد.',
    confirmButton: 'تأكيد',
    cancelButton: 'رجوع',
    announceConfirmed: 'تم التأكيد.',
    announceRecorded: 'سُجّل. لم يُحفظ شيء.',
    basisPrefix: 'استناداً إلى ',
    basisSeparator: '، ',
    basisConjunction: ' و',
    basisSuffix: '.',
  }),
  he: Object.freeze({
    heading: 'צעד הבא אפשרי',
    headingBlind: 'הצעה לבדיקה',
    headingNothing: 'אין מה לבדוק',
    whyHeading: 'למה זה עכשיו',
    leadHeading: 'המוצע',
    slotsHeading: 'הצעות לבדיקה',
    alternativesHeading: 'אפשרויות אחרות',
    excludedHeading: 'מה נפסל',
    confirmNotice: 'שום דבר לא נשמר עד לאישור.',
    confirmPrompt: 'יש לאשר כדי להמשיך. שום דבר עדיין לא נשמר.',
    confirmButton: 'אישור',
    cancelButton: 'חזרה',
    announceConfirmed: 'אושר.',
    announceRecorded: 'נרשם. שום דבר לא נשמר.',
    basisPrefix: 'מבוסס על ',
    basisSeparator: ', ',
    basisConjunction: ' ו',
    basisSuffix: '.',
  }),
});

/* ── Verdicts ────────────────────────────────────────────────────── */

/**
 * The five verdicts, spelled as the shipped pilot spells them.
 *
 * **Same concept at module scope as `NextStepReview.tsx`'s `COPY`**, and the
 * wording is deliberately identical where the verdict is identical: a user who
 * sees "Choose" on one surface and "Accept" on another has two products. #33's
 * `RecommendationDecisionVerdict` is the same five values as the pilot's
 * `NextStepDecision` for the same reason.
 */
export const VERDICT_COPY: ByLocale<RecommendationDecisionVerdict> = Object.freeze({
  en: Object.freeze({
    accept: 'Choose',
    edit: 'Edit',
    defer: 'Later',
    dismiss: 'Dismiss',
    done: 'Already done',
  }),
  ar: Object.freeze({
    accept: 'اختيار',
    edit: 'تعديل',
    defer: 'لاحقاً',
    dismiss: 'تجاهل',
    done: 'تمت بالفعل',
  }),
  he: Object.freeze({
    accept: 'בחירה',
    edit: 'עריכה',
    defer: 'אחר כך',
    dismiss: 'סגירה',
    done: 'כבר בוצע',
  }),
});

/* ── Actions ─────────────────────────────────────────────────────── */

/**
 * What an option proposes, described rather than commanded.
 *
 * The label names the *kind* of move only. Everything that identifies what the
 * move is about — the commitment id, the planned slot, the deferral instant —
 * lives in `ReviewActionSubject`, where a consumer that must not display
 * identifiers drops it and still has a renderable card.
 */
export const ACTION_KIND_COPY: ByLocale<RecommendedAction['kind']> = Object.freeze({
  en: Object.freeze({
    do_now: 'Doing this now',
    schedule: 'Setting a time for it',
    decompose: 'Breaking it into smaller steps',
    defer: 'Moving it to later',
  }),
  ar: Object.freeze({
    do_now: 'القيام بهذا الآن',
    schedule: 'تحديد وقت له',
    decompose: 'تقسيمه إلى خطوات أصغر',
    defer: 'تأجيله إلى وقت لاحق',
  }),
  he: Object.freeze({
    do_now: 'לעשות את זה עכשיו',
    schedule: 'לקבוע לו זמן',
    decompose: 'לפרק אותו לצעדים קטנים',
    defer: 'לדחות אותו למועד מאוחר יותר',
  }),
});

/* ── Reasons ─────────────────────────────────────────────────────── */

export const SUPPORT_REASON_COPY: ByLocale<SupportReasonCode> = Object.freeze({
  en: Object.freeze({
    OVERDUE: 'Its time has already passed.',
    DUE_SOON: 'Its time is close.',
    HIGH_IMPORTANCE: 'You marked it as important.',
    REPEATEDLY_DELAYED: 'It has moved more than once.',
    PLAN_SLOT_IMMINENT: 'A planned slot for it starts soon.',
    UNBLOCKS_DEPENDENTS: 'Other things are waiting on it.',
    QUICK_WIN: 'It looks short.',
    ONLY_ELIGIBLE_ACTION: 'It is the only thing currently available to act on.',
  }),
  ar: Object.freeze({
    OVERDUE: 'مضى وقته بالفعل.',
    DUE_SOON: 'وقته قريب.',
    HIGH_IMPORTANCE: 'وضعت له أهمية عالية.',
    REPEATEDLY_DELAYED: 'تأجّل أكثر من مرة.',
    PLAN_SLOT_IMMINENT: 'هناك وقت مخطّط له يبدأ قريباً.',
    UNBLOCKS_DEPENDENTS: 'أشياء أخرى تنتظره.',
    QUICK_WIN: 'يبدو قصيراً.',
    ONLY_ELIGIBLE_ACTION: 'هو الشيء الوحيد المتاح للعمل عليه الآن.',
  }),
  he: Object.freeze({
    OVERDUE: 'הזמן שלו כבר עבר.',
    DUE_SOON: 'הזמן שלו קרוב.',
    HIGH_IMPORTANCE: 'סימנת אותו כחשוב.',
    REPEATEDLY_DELAYED: 'הוא נדחה יותר מפעם אחת.',
    PLAN_SLOT_IMMINENT: 'זמן מתוכנן עבורו מתחיל בקרוב.',
    UNBLOCKS_DEPENDENTS: 'דברים אחרים ממתינים לו.',
    QUICK_WIN: 'הוא נראה קצר.',
    ONLY_ELIGIBLE_ACTION: 'זה הדבר היחיד שאפשר לפעול עליו כרגע.',
  }),
});

export const EXCLUSION_REASON_COPY: ByLocale<ExclusionReasonCode> = Object.freeze({
  en: Object.freeze({
    NOT_CONFIRMED: 'It has not been confirmed yet.',
    ALREADY_CLOSED: 'It is already closed.',
    INVALID_SOURCE_TIME: 'Its stated time could not be read.',
    BLOCKED_BY_DEPENDENCY: 'It is waiting on something else.',
    NO_PLANNED_SLOT: 'It has no planned slot.',
    OUTSIDE_WORKING_WINDOW: 'It falls outside the working window.',
    INSUFFICIENT_EVIDENCE: 'There is not enough information about it.',
    LOWER_RANKED: 'Other options came out ahead of it.',
    OPTION_CAP_REACHED: 'The list was already full.',
  }),
  ar: Object.freeze({
    NOT_CONFIRMED: 'لم يُؤكَّد بعد.',
    ALREADY_CLOSED: 'مُغلق بالفعل.',
    INVALID_SOURCE_TIME: 'تعذّرت قراءة الوقت المذكور له.',
    BLOCKED_BY_DEPENDENCY: 'ينتظر شيئاً آخر.',
    NO_PLANNED_SLOT: 'لا يوجد له وقت مخطّط.',
    OUTSIDE_WORKING_WINDOW: 'يقع خارج نافذة العمل.',
    INSUFFICIENT_EVIDENCE: 'لا توجد معلومات كافية عنه.',
    LOWER_RANKED: 'خيارات أخرى جاءت قبله.',
    OPTION_CAP_REACHED: 'كانت القائمة ممتلئة.',
  }),
  he: Object.freeze({
    NOT_CONFIRMED: 'הוא עדיין לא אושר.',
    ALREADY_CLOSED: 'הוא כבר סגור.',
    INVALID_SOURCE_TIME: 'לא ניתן היה לקרוא את הזמן שנרשם לו.',
    BLOCKED_BY_DEPENDENCY: 'הוא ממתין לדבר אחר.',
    NO_PLANNED_SLOT: 'אין לו זמן מתוכנן.',
    OUTSIDE_WORKING_WINDOW: 'הוא נופל מחוץ לחלון העבודה.',
    INSUFFICIENT_EVIDENCE: 'אין מספיק מידע עליו.',
    LOWER_RANKED: 'אפשרויות אחרות הגיעו לפניו.',
    OPTION_CAP_REACHED: 'הרשימה כבר הייתה מלאה.',
  }),
});

export const WITHHOLDING_REASON_COPY: ByLocale<WithholdingReasonCode> = Object.freeze({
  en: Object.freeze({
    NO_ELIGIBLE_CANDIDATE: 'There is nothing available to act on right now.',
    ALL_CANDIDATES_EXCLUDED: 'Everything that was considered was ruled out.',
    INSUFFICIENT_EVIDENCE: 'There is not enough information to suggest anything.',
    INPUT_STALE: 'The information this would rest on has already moved on.',
    MODULE_DISABLED: 'Suggestions are turned off.',
  }),
  ar: Object.freeze({
    NO_ELIGIBLE_CANDIDATE: 'لا يوجد شيء متاح للعمل عليه الآن.',
    ALL_CANDIDATES_EXCLUDED: 'استُبعد كل ما جرى النظر فيه.',
    INSUFFICIENT_EVIDENCE: 'لا توجد معلومات كافية لاقتراح أي شيء.',
    INPUT_STALE: 'المعلومات التي يستند إليها هذا قد تغيّرت.',
    MODULE_DISABLED: 'الاقتراحات مُعطّلة.',
  }),
  he: Object.freeze({
    NO_ELIGIBLE_CANDIDATE: 'אין כרגע דבר שאפשר לפעול עליו.',
    ALL_CANDIDATES_EXCLUDED: 'כל מה שנשקל נפסל.',
    INSUFFICIENT_EVIDENCE: 'אין מספיק מידע כדי להציע משהו.',
    INPUT_STALE: 'המידע שעליו זה נשען כבר השתנה.',
    MODULE_DISABLED: 'ההצעות מכובות.',
  }),
});

/* ── Soleness, confidence, sources ───────────────────────────────── */

/**
 * The sentence that turns a lone option from an instruction into a proposal.
 *
 * #33's decision 2 is that "a single option presented with no context reads as
 * 'this is what you must do'; the same option presented beside 'three others
 * were ruled out, here is why' is a proposal the user can push back on". This is
 * where that sentence lives, and `sole_survivor` is the case it exists for.
 */
export const SOLENESS_COPY: ByLocale<OptionSet['kind']> = Object.freeze({
  en: Object.freeze({
    choice: 'There is more than one option here.',
    sole_survivor: 'This is the one option left after the others were ruled out. What was ruled out is listed below.',
    only_candidate: 'This is the only thing that was on the table.',
  }),
  ar: Object.freeze({
    choice: 'هناك أكثر من خيار هنا.',
    sole_survivor: 'هذا هو الخيار الوحيد المتبقّي بعد استبعاد غيره، والمستبعَد مذكور أدناه.',
    only_candidate: 'هذا هو الشيء الوحيد الذي كان مطروحاً.',
  }),
  he: Object.freeze({
    choice: 'יש כאן יותר מאפשרות אחת.',
    sole_survivor: 'זו האפשרות היחידה שנותרה לאחר שהאחרות נפסלו. מה שנפסל מופיע למטה.',
    only_candidate: 'זה הדבר היחיד שהיה על השולחן.',
  }),
});

export const CONFIDENCE_BAND_COPY: ByLocale<ConfidenceBand> = Object.freeze({
  en: Object.freeze({ low: 'Low confidence', medium: 'Moderate confidence', high: 'High confidence' }),
  ar: Object.freeze({ low: 'ثقة منخفضة', medium: 'ثقة متوسطة', high: 'ثقة عالية' }),
  he: Object.freeze({ low: 'ביטחון נמוך', medium: 'ביטחון בינוני', high: 'ביטחון גבוה' }),
});

/**
 * What each locus of trusted state is called in the explanation.
 *
 * Names the *kind*, never the record: "your commitments", not the commitment.
 * This is the rendered form of `TrustedSource['kind']` and it is the whole
 * reason `TrustedSource` is a closed union — a free-string source would have to
 * be either shown raw or dropped, and both are wrong.
 */
export const SOURCE_KIND_COPY: ByLocale<TrustedSource['kind']> = Object.freeze({
  en: Object.freeze({
    commitment: 'your commitments',
    life_state_field: 'your current state',
    priority_score: 'priority scoring',
    plan_slot: 'your plan',
    decomposition_step: 'a step breakdown',
    feedback_aggregate: 'your past responses',
  }),
  ar: Object.freeze({
    commitment: 'التزاماتك',
    life_state_field: 'حالتك الحالية',
    priority_score: 'ترتيب الأولويات',
    plan_slot: 'خطتك',
    decomposition_step: 'تقسيم الخطوات',
    feedback_aggregate: 'استجاباتك السابقة',
  }),
  he: Object.freeze({
    commitment: 'המחויבויות שלך',
    life_state_field: 'המצב הנוכחי שלך',
    priority_score: 'דירוג העדיפויות',
    plan_slot: 'התוכנית שלך',
    decomposition_step: 'פירוק לצעדים',
    feedback_aggregate: 'התגובות הקודמות שלך',
  }),
});

/* ── Nothing to review ───────────────────────────────────────────── */

/**
 * Why the surface is showing nothing.
 *
 * `stale` and `defective` say what happened without naming what was wrong with
 * which node: the codes travel in typed fields on `NothingToReviewView`, where a
 * consumer that must not surface internals drops them.
 */
export const NOTHING_TO_REVIEW_COPY: ByLocale<NothingToReviewCause> = Object.freeze({
  en: Object.freeze({
    withheld: 'There is nothing to suggest right now.',
    stale: 'This suggestion rested on information that has since changed, so it is not being shown.',
    defective: 'This suggestion did not pass its own structural checks, so it is not being shown.',
  }),
  ar: Object.freeze({
    withheld: 'لا يوجد ما يُقترح الآن.',
    stale: 'استند هذا الاقتراح إلى معلومات تغيّرت منذ ذلك الحين، لذلك لا يُعرض.',
    defective: 'لم يجتز هذا الاقتراح فحوصه البنيوية، لذلك لا يُعرض.',
  }),
  he: Object.freeze({
    withheld: 'אין מה להציע כרגע.',
    stale: 'ההצעה הזו נשענה על מידע שהשתנה מאז, ולכן היא אינה מוצגת.',
    defective: 'ההצעה הזו לא עברה את בדיקות המבנה שלה, ולכן היא אינה מוצגת.',
  }),
});
