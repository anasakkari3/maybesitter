/**
 * Every human-readable string the coaching realizer can emit.
 *
 * **No string in this file is assembled from input.** Each is selected by a
 * closed key — a template id and a locale — so there is no path by which a
 * commitment title, a `commitmentId`, a `scopeId`, a `proposalId`, an evidence
 * `nodeId` or a *time* reaches rendered text. That is the same device
 * `lib/recommendation/review/copy.ts` uses, and it is load-bearing twice over
 * here:
 *
 *   - Sprint 07's recorded leak was a detail string reading
 *     `working window call-dr.cohen-about-the-biopsy`, which passed a test that
 *     checked only that titles were absent. A copy table with no interpolation
 *     at all cannot produce that line.
 *   - #39's `FABRICATED_INSTANT` fires when a candidate states a time no
 *     observation carries. This module states no times at all, so it cannot
 *     fire — and `tests/coaching/realizer.test.ts` proves that against **this
 *     table**, not against the claim-kind mapping. The mapping is what this
 *     track decided; the table is where a time would actually get
 *     interpolated, and a guard that checks the decision rather than the thing
 *     that can change is not a guard.
 *
 * The table is typed as `Record<CoachingLocale, Record<CoachingTemplateId, string>>`,
 * so adding a template id without copy in all three locales is a compile error
 * rather than a blank line on screen.
 *
 * ## Wording rules, and where they come from
 *
 * - **Described, never ordered.** `"This is the one worth doing next."`, not
 *   `"Do this next."` A proposal that reads as an instruction is the failure
 *   `NEXT_STEP_PRODUCT_POLICY` and #35's review copy both exist to avoid, and
 *   this module is the last surface before a person reads it.
 * - **No persistence verb, anywhere.** Not `saved`, not `created`, not
 *   `scheduled`, not `reminder`, not `tracking`. The shipped
 *   `responseEngine/validation.ts` forbids these only when
 *   `stateChange === 'completed'`, because the engine genuinely creates
 *   reminders and honestly says so. This module writes nothing, so every one of
 *   them is a false claim here whatever the intent — see
 *   `COACHING_FORBIDDEN_LANGUAGE.trackingVerbs`.
 * - **The completion echo says what the user did, not what the system is
 *   doing about it.** `"You closed that one out."` and nothing after it.
 *   `"...I'll keep an eye on the rest"` is the acceptance criterion's exact
 *   failure in friendly words, and it is the sentence a template author
 *   reaches for.
 * - **One sentence per template.** The realizer emits one claim per sentence,
 *   so a template carrying two sentences would put two claims' worth of
 *   assertion behind one claim's evidence.
 * - **No semicolons**, matching the engine's structural rule.
 */

import type { CoachingLocale } from '../../../src/contracts/v1/coachingContracts';

/**
 * The template ids.
 *
 * Three positions and one echo family:
 *
 * - `lead.*`        — the first sentence of a presenting turn.
 * - `support.*`     — the second sentence, which earns or restates the first.
 * - `alternative.*` — the second sentence of a `name_the_alternatives` turn,
 *                     where the second claim is a *different option* rather
 *                     than a further reason for the first. It is a separate
 *                     family rather than a reuse of `support.proposed_action`
 *                     because the two say different things about the same claim
 *                     kind, and a reader of the output should be able to tell
 *                     which turn produced a sentence from its template id alone.
 * - `echo.*`        — the whole of an acknowledging turn.
 */
export const COACHING_TEMPLATE_IDS = Object.freeze([
  'lead.proposed_action',
  'lead.timing',
  'lead.importance',
  'lead.delay_history',
  'lead.dependency',
  'lead.effort',
  'lead.sole_option',
  'lead.nothing_to_offer',
  'support.proposed_action',
  'support.timing',
  'support.importance',
  'support.delay_history',
  'support.dependency',
  'support.effort',
  'support.sole_option',
  'alternative.proposed_action',
  'echo.user_accepted',
  'echo.user_completed',
  'echo.user_dismissed',
] as const);

export type CoachingTemplateId = (typeof COACHING_TEMPLATE_IDS)[number];

type TemplateTable = Readonly<Record<CoachingLocale, Readonly<Record<CoachingTemplateId, string>>>>;

export const COACHING_TEMPLATES: TemplateTable = Object.freeze({
  en: Object.freeze({
    'lead.proposed_action': 'This is the one worth doing next.',
    'lead.timing': 'The timing is what puts this one first.',
    'lead.importance': 'This one carries more weight than the others.',
    'lead.delay_history': 'This one has slipped more than once.',
    'lead.dependency': 'Other things are waiting behind this one.',
    'lead.effort': 'This one is short.',
    'lead.sole_option': 'This is the only one open right now.',
    'lead.nothing_to_offer': 'There is nothing here that needs a next move.',
    'support.proposed_action': 'That is the move this points to.',
    'support.timing': 'The timing is what puts it ahead.',
    'support.importance': 'Its weight is what puts it ahead.',
    'support.delay_history': 'It has slipped before, which is what puts it ahead.',
    'support.dependency': 'Clearing it opens up what is waiting behind it.',
    'support.effort': 'It is short enough to finish in one go.',
    'support.sole_option': 'There is nothing else open to weigh it against.',
    'alternative.proposed_action': 'The other one is a fair alternative.',
    'echo.user_accepted': 'You picked that one.',
    'echo.user_completed': 'You closed that one out.',
    'echo.user_dismissed': 'You set that one aside.',
  }),
  ar: Object.freeze({
    'lead.proposed_action': 'هذه هي الخطوة التالية الأنسب.',
    'lead.timing': 'التوقيت هو ما يضع هذه في المقدمة.',
    'lead.importance': 'هذه تحمل وزناً أكبر من غيرها.',
    'lead.delay_history': 'هذه تأجّلت أكثر من مرة.',
    'lead.dependency': 'هناك أمور أخرى تنتظر خلف هذه.',
    'lead.effort': 'هذه قصيرة.',
    'lead.sole_option': 'هذه هي الوحيدة المفتوحة الآن.',
    'lead.nothing_to_offer': 'لا يوجد هنا ما يحتاج خطوة تالية.',
    'support.proposed_action': 'هذه هي الخطوة التي تشير إليها الأسباب.',
    'support.timing': 'التوقيت هو ما يقدّمها على غيرها.',
    'support.importance': 'وزنها هو ما يقدّمها على غيرها.',
    'support.delay_history': 'تأجّلها المتكرر هو ما يقدّمها على غيرها.',
    'support.dependency': 'إنهاؤها يفتح الطريق لما ينتظر خلفها.',
    'support.effort': 'قِصَرها يجعل إنهاءها ممكناً دفعة واحدة.',
    'support.sole_option': 'لا يوجد غيرها مفتوحاً لتوازن به.',
    'alternative.proposed_action': 'والخيار الآخر بديل معقول.',
    'echo.user_accepted': 'اخترت تلك.',
    'echo.user_completed': 'أنهيت تلك.',
    'echo.user_dismissed': 'نحّيت تلك جانباً.',
  }),
  he: Object.freeze({
    'lead.proposed_action': 'זו הפעולה הבאה המתאימה ביותר.',
    'lead.timing': 'העיתוי הוא מה שמציב את זו בראש.',
    'lead.importance': 'לזו יש משקל גדול יותר מהשאר.',
    'lead.delay_history': 'זו נדחתה יותר מפעם אחת.',
    'lead.dependency': 'דברים אחרים ממתינים מאחורי זו.',
    'lead.effort': 'זו קצרה.',
    'lead.sole_option': 'זו היחידה הפתוחה כרגע.',
    'lead.nothing_to_offer': 'אין כאן דבר שדורש פעולה נוספת.',
    'support.proposed_action': 'לשם מצביעות הסיבות.',
    'support.timing': 'העיתוי הוא מה שמקדם אותה.',
    'support.importance': 'המשקל שלה הוא מה שמקדם אותה.',
    'support.delay_history': 'הדחיות החוזרות הן מה שמקדם אותה.',
    'support.dependency': 'סגירתה מפנה את מה שממתין מאחוריה.',
    'support.effort': 'היא קצרה דיה כדי להיסגר בבת אחת.',
    'support.sole_option': 'אין אחרת פתוחה להשוות אליה.',
    'alternative.proposed_action': 'והאפשרות השנייה סבירה גם היא.',
    'echo.user_accepted': 'בחרת בזו.',
    'echo.user_completed': 'סגרת את זו.',
    'echo.user_dismissed': 'הנחת את זו בצד.',
  }),
});

/**
 * The copy for a template id in a locale, or null.
 *
 * Null rather than an English fallback. A missing translation silently served
 * in English is a defect that reads as a feature to everyone who speaks
 * English, which is everyone who reviews it — the same asymmetry that let the
 * pilot's four `localeCompare` sites survive review. `UNKNOWN_LOCALE` is the
 * code the caller reports.
 */
export function templateText(locale: CoachingLocale, id: CoachingTemplateId): string | null {
  const byLocale = (COACHING_TEMPLATES as Readonly<Record<string, Readonly<Record<string, string>>>>)[locale as string];
  if (byLocale === undefined) return null;
  const text = byLocale[id as string];
  return text === undefined ? null : text;
}
