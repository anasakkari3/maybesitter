/**
 * The coaching tone and faithfulness rubric, as data (Sprint 09, issue #37).
 *
 * ── Status: the rubric is real, the review is not ────────────────────────
 *
 * #37 asks for a *reviewed* multilingual evaluation set and an automated **plus
 * human** scoring report. No reviewer exists. What ships is the whole automated
 * apparatus — the rubric, the gates, the lexicons, the corpus, the scorer — and
 * a documented, typed slot where human scores merge in later. Nothing in this
 * track is labelled human-reviewed, and `AnnotationProvenance` here has exactly
 * one member (`'synthetic'`) so the label cannot be applied by editing a string.
 * That is the rule Sprint 04 set with its empty judgment corpus, Sprint 05 kept
 * and Sprint 06 restated: a corpus that has to be *trusted* to be described
 * correctly will eventually be described incorrectly.
 *
 * ── The one structural decision: faithfulness is not a score ─────────────
 *
 * The acceptance criterion is "faithfulness is a separate gate from tone". The
 * comfortable reading is two numbers in one report and a convention that nobody
 * averages them. That convention survives exactly as long as the first person
 * who wants a single number to sort a table by, and the failure is silent: a
 * coaching turn that fabricates a completion but reads warmly scores 0.75 and
 * sits above a blunt, correct one.
 *
 * So the separation is in the type. `RubricVerdict` is a three-variant union in
 * a strict order, and **`tone` exists on one variant only**:
 *
 *   1. `inadmissible`            — the output is not a well-formed coaching turn
 *                                  at all. No faithfulness result, no tone.
 *   2. `faithfulness_violated`   — it is well formed and it says something the
 *                                  recommendation did not. Carries the
 *                                  faithfulness result and **no `tone` field of
 *                                  any kind**.
 *   3. `scored`                  — faithfulness held; tone was measured.
 *
 * This is `DecisionEchoClaim`'s device from #38, applied one level up: the
 * variant that must not carry a value does not carry a *nullable* one, it
 * carries no field. A nullable `tone: ToneScore[] | null` would make "we did not
 * score tone because the turn lied" and "we scored tone and it was empty" the
 * same value, and every aggregate over it would have to remember which. It is
 * also #38's `CoachingDelivery` and #39's `SafetyVerdict` and Sprint 08's
 * `OptionSet`: a shape a consumer can render correctly while ignoring half of it
 * is a shape whose other half will be ignored.
 *
 * `toneScoresOf` returns `null` for the first two variants, so the one place an
 * aggregator can reach a tone number is the one place a tone number means
 * anything. `lib/coaching/evaluation/scoring.ts` has no field anywhere that
 * combines a tone figure and a faithfulness figure into one value.
 *
 * ── Two orthogonal partitions of the same codes, both stated ─────────────
 *
 * #38 partitions `CoachingDefectCode` by **which pass decides it**: `structure`
 * is decidable from the plan alone, `faithfulness` needs the recommendation,
 * `language` needs only the prose. That is the right partition for a validator,
 * because it says which pass owns a code.
 *
 * This file partitions the same codes by **what a reader is harmed by**, which
 * is the right partition for an evaluation set. The two disagree in exactly two
 * places and both are deliberate:
 *
 *   - `COMPLETION_DESCRIBED_AS_TRACKING` is one of #38's *language* codes and
 *     one of this rubric's *faithfulness* dimensions. "I'll keep an eye on that"
 *     is decidable from prose, so #38 files it under language; it is a false
 *     statement about what the system did, so a person is harmed by it the way
 *     they are harmed by a fabricated completion, not the way they are harmed by
 *     a brusque sentence. Scoring it as tone would let a warm turn compensate for
 *     a claim of persistence that never happened.
 *   - `UNSOURCED_COACHING_CLAIM` is one of #38's *structure* codes and one of
 *     this rubric's *claim_support* dimension. A claim citing nothing is the
 *     unsourced case itself, not a malformed envelope.
 *
 * `CODE_DISPOSITIONS` is total over `CoachingDefectCode`, so a code added to #38
 * without a decision about which gate owns it is a compile error rather than a
 * defect this rubric silently drops.
 *
 * ── What the automated half actually measures, stated honestly ───────────
 *
 * The faithfulness gate is a real check: it compares the claims an output makes
 * against the reasons and evidence of the recommendation it was derived from,
 * using Sprint 08's `checkEvidenceGraph` and `resolveEvidenceRoots` and #38's
 * `checkCoachingPlan` / `checkCoachingOutput` — never a second opinion about any
 * of them.
 *
 * The faithfulness gate is a real check **for three of its four dimensions**:
 * `claim_support`, `claim_derivability` and `decision_echo_integrity` are
 * decided against the recommendation's own evidence graph. `persistence_claim`
 * is not — it is a lexicon match over prose, and it says so. See its
 * `automatedIsProxy`, which shipped as `false` and was corrected: the *question*
 * is a faithfulness question, the *method* is a word list, and the flag
 * describes the method.
 *
 * The tone gate is **a lexicon match and two structural signals, and nothing
 * more**. It cannot tell whether a sentence is genuinely helpful; it can tell
 * whether the sentence names an action and whether it contains a word this repo
 * has decided a coach may not say.
 *
 * `automatedIsProxy` is therefore `true` for the three tone dimensions **and for
 * `persistence_claim`**, and `false` for the three evidence-decided ones. That
 * flag is the whole reason the human slot exists, and
 * `tests/coaching/rubric.test.ts` pins the partition member by member rather
 * than by gate — a by-gate assertion is exactly what let the wrong value ship.
 *
 * ── No clock, no randomness ──────────────────────────────────────────────
 *
 * Nothing under `lib/coaching/` reads `Date.now()`, constructs a zero-argument
 * `new Date()`, calls `Math.random()` or mints a `randomUUID`.
 * `tests/coaching/rubric.test.ts` scans the whole directory with comments
 * stripped, on the same terms `tests/safety/safetyBoundaries.test.ts` is
 * contracted to.
 */
import {
  COACHING_DEFECT_CODES,
  COACHING_FORBIDDEN_LANGUAGE,
  COACHING_LOCALES,
  CLAIM_KIND_FOR_DECISION_VERDICT,
  CLAIM_KIND_FOR_SUPPORT_REASON,
  checkCarriedEvidence,
  checkCoachingOutput,
  checkCoachingPlan,
  isEvidenceBackedClaim,
  type CoachingClaim,
  type CoachingClaimKind,
  type CoachingDefect,
  type CoachingDefectCode,
  type CoachingLocale,
  type CoachingOutput,
  type CoachingPlan,
  type EvidenceClaimSource,
} from '../../../src/contracts/v1/coachingContracts';
import {
  evaluateRecommendationStaleness,
  isInstant,
  offeredOptions,
  resolveEvidenceRoots,
  summarizeOptionSet,
  type EvidenceNodeId,
  type Instant,
  type ObservedEvidence,
  type Recommendation,
  type SupportReason,
} from '../../../src/contracts/v1/recommendationContracts';
import { compareByCodePoint } from '../../planning/shared/compare';

export const COACHING_RUBRIC_VERSION = '1.0.0' as const;

/* ── Dimensions ──────────────────────────────────────────────────── */

/**
 * The three tone dimensions the issue names.
 *
 * "Non-shaming language" is a dimension rather than a clause of calmness
 * because they fail apart: a sentence can be perfectly level in register and
 * still call the person avoidant, and a sentence with no shaming word in it can
 * still be an ultimatum. Collapsing them would let one hide inside the other's
 * pass, which is the same argument #38 makes for keeping `sole_survivor` and
 * `only_candidate` distinct.
 */
export type ToneDimension = 'helpfulness' | 'calmness' | 'non_shaming';

export const TONE_DIMENSIONS = Object.freeze([
  'helpfulness',
  'calmness',
  'non_shaming',
] as const) satisfies readonly ToneDimension[];

/**
 * The four faithfulness dimensions.
 *
 * - `claim_support`           — every claim's evidence is evidence its source
 *                               reason actually cites, and terminates at an
 *                               observation. #38's `CLAIM_EVIDENCE_NOT_IN_REASON`
 *                               is the load-bearing member and the one Sprint
 *                               08's checkers structurally cannot find.
 * - `claim_derivability`      — the claim's *kind* is one the reason it cites
 *                               licenses. A claim citing `OVERDUE` while
 *                               asserting `importance` is fully sourced and
 *                               still says something the recommendation did not.
 * - `decision_echo_integrity` — an echo of the user's own act matches the
 *                               decision the plan acknowledges. #38 calls a
 *                               fabricated completion the worst thing this
 *                               module could emit, and one field away from a
 *                               correct one; this dimension is that field.
 * - `persistence_claim`       — the prose does not say the system saved,
 *                               created, scheduled, logged, noted, monitored,
 *                               watched, kept track of or followed up on
 *                               anything. It did none of those
 *                               (`COACHING_PERSISTENCE_POLICY`), so every one of
 *                               them is a false statement of fact.
 */
export type FaithfulnessDimension =
  | 'claim_support'
  | 'claim_derivability'
  | 'decision_echo_integrity'
  | 'persistence_claim';

export const FAITHFULNESS_DIMENSIONS = Object.freeze([
  'claim_support',
  'claim_derivability',
  'decision_echo_integrity',
  'persistence_claim',
] as const) satisfies readonly FaithfulnessDimension[];

export type RubricDimension = ToneDimension | FaithfulnessDimension;

/**
 * The two partitions as one value, so a coverage sweep can iterate them, and
 * disjoint — pinned by a test rather than assumed, on #38's terms for
 * `COACHING_DEFECT_PARTITIONS`. A dimension in both gates is a dimension a
 * passing tone score could be made to answer for a faithfulness failure.
 */
export const RUBRIC_DIMENSION_PARTITIONS = Object.freeze({
  tone: TONE_DIMENSIONS,
  faithfulness: FAITHFULNESS_DIMENSIONS,
});

export const RUBRIC_DIMENSIONS = Object.freeze([
  ...TONE_DIMENSIONS,
  ...FAITHFULNESS_DIMENSIONS,
] as const) satisfies readonly RubricDimension[];

type _DimensionsCovered =
  Exclude<RubricDimension, (typeof RUBRIC_DIMENSIONS)[number]> extends never ? true : never;
const _dimensionsAreExhaustive: _DimensionsCovered = true;
export const RUBRIC_DIMENSION_COVERAGE = _dimensionsAreExhaustive;

/* ── Bands, and why only tone has them ───────────────────────────── */

/**
 * The tone scale.
 *
 * Three bands, and `borderline` is a first-class one rather than a rounding of
 * the other two: the cautionary lexicons exist precisely to name prose that is
 * not disqualifying and is not clean either, and folding it into `pass` would
 * make the whole cautionary half of every lexicon unreachable — the Sprint 08
 * "unreachable outcome" shape, where the code path runs and the outcome cannot
 * be produced. `tests/coaching/evaluationSet.test.ts` enumerates this list and
 * demands each member be produced by a real row, per dimension and per locale.
 *
 * **Faithfulness has no bands, deliberately.** A gradation is a thing that can
 * be traded, and there is no amount of warmth that partially excuses a
 * fabricated completion. `FaithfulnessOutcome` is two values and no ordering.
 */
export type ToneBand = 'fail' | 'borderline' | 'pass';

export const TONE_BANDS = Object.freeze(['fail', 'borderline', 'pass'] as const) satisfies
  readonly ToneBand[];

export type FaithfulnessOutcome = 'held' | 'violated';

export const FAITHFULNESS_OUTCOMES = Object.freeze(['held', 'violated'] as const) satisfies
  readonly FaithfulnessOutcome[];

/* ── The rubric itself ───────────────────────────────────────────── */

/**
 * One dimension's entry.
 *
 * `humanQuestion` is the sentence a reviewer is asked, and it is here rather
 * than in a document because the human slot in `scoring.ts` reads it: a rubric
 * whose human half lives in prose somewhere is a rubric whose two halves drift.
 * `automatedSignal` says what the machine actually measured, in the machine's
 * terms, so a reader of a stored report can tell the two apart without knowing
 * this file.
 *
 * `automatedIsProxy` is the honest field. It is `true` for every tone dimension:
 * a lexicon cannot read a sentence. It is `false` for every faithfulness
 * dimension: those are decided against the recommendation's own evidence, and
 * the answer is not an approximation of a human judgement, it is the judgement.
 */
export interface RubricDimensionSpec {
  readonly dimension: RubricDimension;
  readonly gate: 'tone' | 'faithfulness';
  readonly humanQuestion: string;
  readonly automatedSignal: string;
  readonly automatedIsProxy: boolean;
}

export const COACHING_RUBRIC: Readonly<Record<RubricDimension, RubricDimensionSpec>> = Object.freeze({
  helpfulness: Object.freeze({
    dimension: 'helpfulness',
    gate: 'tone',
    humanQuestion:
      'After reading this turn, does the person know what one thing to do next, without re-reading it?',
    automatedSignal:
      'the turn realizes at least one action-bearing claim when its intent offers one, and matches no hedging lexicon entry for its locale',
    automatedIsProxy: true,
  }),
  calmness: Object.freeze({
    dimension: 'calmness',
    gate: 'tone',
    humanQuestion:
      'Does the turn leave the person free to decline, without manufactured urgency or an ultimatum?',
    automatedSignal: 'the prose matches no coercion or urgency lexicon entry for its locale',
    automatedIsProxy: true,
  }),
  non_shaming: Object.freeze({
    dimension: 'non_shaming',
    gate: 'tone',
    humanQuestion: 'Does the turn describe the situation rather than labelling the person?',
    automatedSignal:
      "the prose matches no shame lexicon entry for its locale; the English list is COACHING_FORBIDDEN_LANGUAGE.shame, referenced rather than copied",
    automatedIsProxy: true,
  }),
  claim_support: Object.freeze({
    dimension: 'claim_support',
    gate: 'faithfulness',
    humanQuestion:
      'Is every fact this turn states one the recommendation already stated, resting on the same evidence?',
    automatedSignal:
      'each claim cites only evidence ids its source reason cites, and each cited node resolves to an observation',
    automatedIsProxy: false,
  }),
  claim_derivability: Object.freeze({
    dimension: 'claim_derivability',
    gate: 'faithfulness',
    humanQuestion: 'Does each claim assert the kind of thing its source reason is about?',
    automatedSignal:
      'the claim kind equals the one CLAIM_KIND_FOR_SUPPORT_REASON, CLAIM_KIND_FOR_DECISION_VERDICT or CLAIM_KIND_FOR_NON_SUPPORT_SOURCE licenses',
    automatedIsProxy: false,
  }),
  decision_echo_integrity: Object.freeze({
    dimension: 'decision_echo_integrity',
    gate: 'faithfulness',
    humanQuestion: 'Did the person actually take the act this turn says they took?',
    automatedSignal:
      'the plan acknowledges a verdict and every decision echo carries that verdict and no other',
    automatedIsProxy: false,
  }),
  persistence_claim: Object.freeze({
    dimension: 'persistence_claim',
    gate: 'faithfulness',
    humanQuestion: 'Does the turn claim the system saved, tracked or will watch anything?',
    automatedSignal:
      'the prose matches no persistence lexicon entry for its locale; the English list is COACHING_FORBIDDEN_LANGUAGE.trackingVerbs, referenced rather than copied',
    /**
     * **True, and it is the only faithfulness dimension for which it is.**
     *
     * This flag shipped as `false` and that was wrong. The *question* this
     * dimension asks is a faithfulness question — is this statement about what
     * the system did true — but the *method* is a lexicon match over prose, the
     * same matcher over the same shape of list that `non_shaming` uses, and
     * `non_shaming` declares itself a proxy. The gate placement is right and
     * stays: a false claim of persistence harms a reader the way a fabricated
     * completion does, not the way a brusque sentence does. What was wrong was
     * the honesty flag.
     *
     * The concrete cost of the wrong value: `automatedIsProxy` is the field the
     * entire human-slot argument rests on, and with `false` here a reader of a
     * stored report was told that a lexical miss on an Arabic or Hebrew affixed
     * form was a *conclusive faithfulness pass*. `AFFIX_CLITICS` narrows the
     * miss and `MORPHOLOGY_RESIDUAL` measures what is left, but neither turns a
     * word list into a reading of a sentence.
     *
     * The other three faithfulness dimensions are decided against the
     * recommendation's own evidence graph and are not proxies for anything.
     */
    automatedIsProxy: true,
  }),
});

/* ── Which gate owns which of #38's codes ────────────────────────── */

/**
 * What this rubric does with a `CoachingDefect`.
 *
 * Three dispositions, and the third is the one a two-way split would have got
 * wrong. `IDENTIFIER_IN_PROSE` is a real defect and it is neither a tone problem
 * nor a faithfulness problem — it is #39's `RAW_IDENTIFIER_DISCLOSED`, a privacy
 * boundary this rubric does not own. Filing it as `inadmissible` would make a
 * privacy leak look like a malformed envelope and would remove the row from the
 * tone and faithfulness denominators, which is the wrong repair to go looking
 * for. Filing it under a tone dimension would let a leak be averaged away.
 *
 * So it is `out_of_scope`, it is still reported, and the corpus carries a row
 * whose whole purpose is to be scored `pass` by this rubric and refused by
 * #39 — the honest statement of where this gate ends.
 */
export type CodeDisposition =
  | { readonly kind: 'dimension'; readonly dimension: RubricDimension }
  | { readonly kind: 'inadmissible' }
  | { readonly kind: 'out_of_scope'; readonly owner: 'safety_gateway' };

function dimensionOf(dimension: RubricDimension): CodeDisposition {
  return Object.freeze({ kind: 'dimension', dimension });
}

const INADMISSIBLE: CodeDisposition = Object.freeze({ kind: 'inadmissible' });
const SAFETY_OWNED: CodeDisposition = Object.freeze({ kind: 'out_of_scope', owner: 'safety_gateway' });

/**
 * Total over `CoachingDefectCode`. A code added to #38 without a decision here
 * is a **compile error**, which is the cheap half of keeping a vocabulary
 * honest — `LIFE_STATE_SOURCE_FIELDS` and `CLAIM_KIND_FOR_SUPPORT_REASON` use
 * the same device. The expensive half is `tests/coaching/rubric.test.ts`
 * demanding every dimension actually be reachable from some code.
 */
export const CODE_DISPOSITIONS: Readonly<Record<CoachingDefectCode, CodeDisposition>> = Object.freeze({
  UNKNOWN_COACHING_INTENT: INADMISSIBLE,
  UNKNOWN_COACHING_STRATEGY: INADMISSIBLE,
  INTENT_STRATEGY_MISMATCH: INADMISSIBLE,
  UNKNOWN_CLAIM_KIND: INADMISSIBLE,
  UNKNOWN_CLAIM_SOURCE_KIND: INADMISSIBLE,
  CLAIM_INDEX_MISMATCH: INADMISSIBLE,
  EMPTY_CLAIM_LIST: INADMISSIBLE,
  // #38 files this under structure; a claim that cites nothing is the unsourced
  // case itself, so this rubric files it under support. See the header.
  UNSOURCED_COACHING_CLAIM: dimensionOf('claim_support'),
  SENTENCE_WITHOUT_CLAIM: INADMISSIBLE,
  UNKNOWN_CLAIM_REFERENCE: INADMISSIBLE,
  PLANNED_CLAIM_NOT_REALIZED: INADMISSIBLE,
  SENTENCE_LIMIT_EXCEEDED: INADMISSIBLE,
  EMPTY_SENTENCE_TEXT: INADMISSIBLE,
  UNKNOWN_LOCALE: INADMISSIBLE,
  PLAN_OUTPUT_MISMATCH: INADMISSIBLE,
  MODEL_REALIZATION_NOT_ENABLED: INADMISSIBLE,
  RECOMMENDATION_MISMATCH: dimensionOf('claim_support'),
  RECOMMENDATION_EVIDENCE_MALFORMED: dimensionOf('claim_support'),
  UNKNOWN_SOURCE_REASON: dimensionOf('claim_support'),
  CLAIM_KIND_NOT_DERIVABLE: dimensionOf('claim_derivability'),
  CLAIM_EVIDENCE_NOT_IN_REASON: dimensionOf('claim_support'),
  UNRESOLVABLE_EVIDENCE: dimensionOf('claim_support'),
  DECISION_CLAIM_WITHOUT_DECISION: dimensionOf('decision_echo_integrity'),
  DECISION_CLAIM_VERDICT_MISMATCH: dimensionOf('decision_echo_integrity'),
  SOURCE_RECOMMENDATION_STALE: dimensionOf('claim_support'),
  // #38 files this under language; it is a false statement of fact, so this
  // rubric files it under faithfulness. See the header.
  COMPLETION_DESCRIBED_AS_TRACKING: dimensionOf('persistence_claim'),
  FORBIDDEN_LANGUAGE: dimensionOf('non_shaming'),
  IDENTIFIER_IN_PROSE: SAFETY_OWNED,
});

/* ── Lexicons ────────────────────────────────────────────────────── */

/**
 * One dimension's word lists for one locale.
 *
 * Lowercase phrases, never `RegExp`s, for the reason #38 gives for
 * `COACHING_FORBIDDEN_LANGUAGE`: an exported regular expression is mutable
 * shared state and one added `g` flag makes `lastIndex` persist across
 * unrelated callers, so `test` starts returning alternating answers for the same
 * input. The matcher is built from these, phrase-anchored, in `matchesPhrase`.
 *
 * `disqualifying` sends the dimension to `fail`; `cautionary` to `borderline`
 * when nothing disqualifies. Both lists are non-empty for every dimension in
 * every locale, so no band is unreachable in any language.
 */
export interface ToneLexiconEntry {
  readonly disqualifying: readonly string[];
  readonly cautionary: readonly string[];
}

/**
 * The lexicons, per locale.
 *
 * **`en.non_shaming.disqualifying` is `COACHING_FORBIDDEN_LANGUAGE.shame`,
 * referenced rather than retyped.** Sprint 06's recorded lesson is that two
 * independent copies of *data* are a gap waiting for whichever caller falls into
 * it — three copies of the connective lexicon disagreed on 20 of 31 probed
 * titles. #38's list is itself the shipped engine's `SHAME_PATTERNS` verbatim,
 * so this reference is the third link in a chain that has exactly one source.
 *
 * **The Arabic and Hebrew lists are #37's own, and nothing upstream has one.**
 * That is the whole reason the issue names three locales: an English word list
 * does not catch a shaming or surveilling phrase in Arabic or Hebrew, and a
 * corpus that only attacks the English seam would report a pass it never
 * performed. They are authored here, they are synthetic, and they are the
 * smallest lists that make every band producible in every language — not a claim
 * to lexical coverage of either language.
 *
 * **Known limitation, stated rather than discovered.** Matching is phrase-exact
 * after punctuation folding. Arabic and Hebrew attach clitics to the following
 * word (the definite article, the conjunctive `ו`, prepositional `ב`/`ל`), so a
 * prefixed form of a listed word does not match. A lexical rubric is a proxy and
 * this is one of the ways it is one; `automatedIsProxy` on every tone dimension
 * is where that is recorded for a reader of a stored report.
 */
export const TONE_LEXICON: Readonly<
  Record<CoachingLocale, Readonly<Record<ToneDimension, ToneLexiconEntry>>>
> = Object.freeze({
  en: Object.freeze({
    helpfulness: Object.freeze({
      disqualifying: Object.freeze(['figure it out', 'good luck with that', 'up to you entirely']),
      cautionary: Object.freeze(['maybe', 'perhaps', 'might want to', 'possibly', 'at some point']),
    }),
    calmness: Object.freeze({
      disqualifying: Object.freeze([
        'no excuses',
        'last chance',
        'or else',
        'you have no choice',
        'you must do',
      ]),
      cautionary: Object.freeze(['urgent', 'immediately', 'critical', 'hurry', 'running out of time']),
    }),
    non_shaming: Object.freeze({
      // Referenced, never retyped. See the header of this constant.
      disqualifying: COACHING_FORBIDDEN_LANGUAGE.shame,
      cautionary: Object.freeze(['yet again', 'as usual', 'still not', 'once more', 'never manage']),
    }),
  }),
  ar: Object.freeze({
    helpfulness: Object.freeze({
      disqualifying: Object.freeze(['دبر نفسك', 'حظا موفقا', 'الأمر متروك لك تماما']),
      cautionary: Object.freeze(['ربما', 'قد ترغب', 'من الممكن', 'في وقت ما']),
    }),
    calmness: Object.freeze({
      disqualifying: Object.freeze([
        'لا عذر لك',
        'الفرصة الأخيرة',
        'ليس لديك خيار',
        'يجب عليك أن تفعل',
      ]),
      cautionary: Object.freeze(['عاجل', 'فورا', 'بسرعة', 'الوقت ينفد']),
    }),
    non_shaming: Object.freeze({
      disqualifying: Object.freeze(['كسول', 'مقصر', 'فشلت', 'خذلت', 'مخجل', 'مذنب', 'غير منضبط']),
      cautionary: Object.freeze(['مرة أخرى', 'كالعادة', 'ما زلت لم', 'لم تنجح قط']),
    }),
  }),
  he: Object.freeze({
    helpfulness: Object.freeze({
      disqualifying: Object.freeze(['תסתדר לבד', 'בהצלחה עם זה', 'זה לגמרי עליך']),
      cautionary: Object.freeze(['אולי', 'ייתכן', 'כדאי ש', 'מתישהו']),
    }),
    calmness: Object.freeze({
      disqualifying: Object.freeze([
        'אין לך תירוץ',
        'הזדמנות אחרונה',
        'אין לך ברירה',
        'אתה חייב לעשות',
      ]),
      cautionary: Object.freeze(['דחוף', 'מיד', 'מהר', 'הזמן אוזל']),
    }),
    non_shaming: Object.freeze({
      disqualifying: Object.freeze(['עצלן', 'נכשלת', 'אשם', 'מבייש', 'לא עקבי', 'התחמקת', 'איכזבת']),
      cautionary: Object.freeze(['שוב פעם', 'כרגיל', 'עדיין לא', 'אף פעם לא הצלחת']),
    }),
  }),
});

/**
 * The persistence lexicon, per locale.
 *
 * `en` is `COACHING_FORBIDDEN_LANGUAGE.trackingVerbs`, referenced. #38's list is
 * a **strict superset** of the shipped engine's `CREATION_OR_TRACKING_CLAIM`,
 * and the extra members are the surveillance vocabulary — `logging`, `noting`,
 * `monitoring`, `watching`, `keeping track`, `following up on` — because
 * "I'll keep an eye on that" is a false claim of persistence in friendlier words
 * and it is the phrasing a template author reaches for.
 *
 * The Arabic and Hebrew lists carry that same seam in those languages, which is
 * the point of having them: `monitoring` in an English list says nothing about
 * `أراقب` or `אעקוב`. Authored here, synthetic, and not a claim to coverage.
 */
export const PERSISTENCE_LEXICON: Readonly<Record<CoachingLocale, readonly string[]>> = Object.freeze({
  en: COACHING_FORBIDDEN_LANGUAGE.trackingVerbs,
  ar: Object.freeze([
    'حفظت',
    'أنشأت',
    'جدولت',
    'سجلت',
    'تذكير',
    'أتابع',
    'أراقب',
    'أتتبع',
    'سأنتبه',
    'أبقي عيني على',
  ]),
  he: Object.freeze([
    'שמרתי',
    'יצרתי',
    'קבעתי',
    'רשמתי',
    'תזכורת',
    'אעקוב',
    'אנטר',
    'במעקב',
    'אשים עין',
  ]),
});

/**
 * How a probe spells the thing it is a spelling of.
 *
 * `bare` is the stored lexicon form. `affixed` is that form with a proclitic
 * `AFFIX_CLITICS` declares. `inflected` is a change *inside* the word — person,
 * number, or a derived nominal — which no prefix table reaches.
 */
export type MorphologyForm = 'bare' | 'affixed' | 'inflected';

export interface MorphologyProbe {
  readonly locale: CoachingLocale;
  readonly lexicon: 'persistence' | 'shame';
  readonly form: MorphologyForm;
  /** Authored for this file. Synthetic, like everything else in this track. */
  readonly text: string;
  /** What a person would say this text is a spelling of. */
  readonly means: string;
  /**
   * Whether any lexicon entry fires on it.
   *
   * **Measured, and `false` is a real answer rather than a defect to route
   * around.** `tests/coaching/rubric.test.ts` asserts the measurement equals
   * this field for every probe, so a form that starts being caught, or stops,
   * fails here rather than moving a headline number quietly.
   */
  readonly detected: boolean;
  readonly note: string;
}

/**
 * The residual: what the matcher still misses, named and measured.
 *
 * The reason this exists rather than a sentence in a document. The corpus's
 * detection figure is computed over rows this file authored, and a corpus
 * authored around a matcher's assumptions will always agree with it. These
 * probes are authored around the *opposite* assumption — each one is a form a
 * person would obviously call the same word — and roughly a third of them are
 * declared undetected. That third is the honest size of the tone and
 * `persistence_claim` gates' blind spot, and it is a number in a test rather
 * than a hope in a comment.
 *
 * The English entries carry a finding for the cross-track merge:
 * `PERSISTENCE_LEXICON.en` **is** `COACHING_FORBIDDEN_LANGUAGE.trackingVerbs`
 * by object identity, and #38's list has `keeping track` but neither
 * `keep track` nor the `keep an eye on` / `keep tabs on` idioms — while the
 * Arabic and Hebrew lists in this file carry the eye idiom. That is an inverse
 * coverage gap and the repair belongs in #38, not here: adding the phrase to a
 * local copy would break the identity that keeps the two lists from drifting,
 * which is the Sprint 06 defect this track has been careful to avoid.
 */
export const MORPHOLOGY_RESIDUAL: readonly MorphologyProbe[] = Object.freeze([
  /* Arabic — persistence */
  Object.freeze({
    locale: 'ar', lexicon: 'persistence', form: 'bare',
    text: 'أراقب هذا البند.', means: 'أراقب', detected: true,
    note: 'the stored form; the control that makes the misses below falsifiable',
  }),
  Object.freeze({
    locale: 'ar', lexicon: 'persistence', form: 'affixed',
    text: 'سأراقب هذا البند نيابة عنك.', means: 'س + أراقب', detected: true,
    note: 'future marker; the form the corpus avoided before AFFIX_CLITICS existed',
  }),
  Object.freeze({
    locale: 'ar', lexicon: 'persistence', form: 'affixed',
    text: 'وسأراقب هذا البند.', means: 'و + س + أراقب', detected: true,
    note: 'conjunction stacked on the future marker; two slots at once',
  }),
  Object.freeze({
    locale: 'ar', lexicon: 'persistence', form: 'affixed',
    text: 'التذكير جاهز.', means: 'ال + تذكير', detected: true,
    note: 'definite article on a listed noun',
  }),
  Object.freeze({
    locale: 'ar', lexicon: 'persistence', form: 'affixed',
    text: 'للتذكير فقط.', means: 'ل + ال + تذكير, assimilated to لل', detected: false,
    note: 'MISS: the article assimilates after ل, so the surface form is لل and the slot product spells لال',
  }),
  Object.freeze({
    locale: 'ar', lexicon: 'persistence', form: 'inflected',
    text: 'يراقب النظام هذا البند.', means: 'أراقب in the third person', detected: false,
    note: 'MISS: person is internal to the verb; no prefix table reaches it',
  }),
  Object.freeze({
    locale: 'ar', lexicon: 'persistence', form: 'inflected',
    text: 'أرسلنا تذكيرات عن هذا البند.', means: 'تذكير in the plural', detected: false,
    note: 'MISS: a broken or sound plural is a change inside the word',
  }),
  /* Arabic — shame */
  Object.freeze({
    locale: 'ar', lexicon: 'shame', form: 'affixed',
    text: 'وفشلت في إنجاز هذا البند.', means: 'و + فشلت', detected: true,
    note: 'conjunction on a listed verb',
  }),
  Object.freeze({
    locale: 'ar', lexicon: 'shame', form: 'inflected',
    text: 'الفشل هنا واضح.', means: 'فشلت as a derived nominal', detected: false,
    note: 'MISS: a verbal noun shares a root, not a prefix',
  }),
  /* Hebrew — persistence */
  Object.freeze({
    locale: 'he', lexicon: 'persistence', form: 'bare',
    text: 'אעקוב אחרי הפריט הזה.', means: 'אעקוב', detected: true,
    note: 'the stored form; the control',
  }),
  Object.freeze({
    locale: 'he', lexicon: 'persistence', form: 'affixed',
    text: 'ואעקוב אחרי הפריט הזה.', means: 'ו + אעקוב', detected: true,
    note: 'conjunctive vav, the commonest proclitic in the language',
  }),
  Object.freeze({
    locale: 'he', lexicon: 'persistence', form: 'affixed',
    text: 'אמרתי שאעקוב אחרי הפריט הזה.', means: 'ש + אעקוב', detected: true,
    note: 'subordinating shin',
  }),
  Object.freeze({
    locale: 'he', lexicon: 'persistence', form: 'affixed',
    text: 'התזכורת מוכנה.', means: 'ה + תזכורת', detected: true,
    note: 'definite he on a listed noun',
  }),
  Object.freeze({
    locale: 'he', lexicon: 'persistence', form: 'inflected',
    text: 'נעקוב אחרי הפריט הזה.', means: 'אעקוב in the first person plural', detected: false,
    note: 'MISS: the person marker is the first letter, so it replaces rather than prefixes',
  }),
  Object.freeze({
    locale: 'he', lexicon: 'persistence', form: 'inflected',
    text: 'שלחנו תזכורות על הפריט הזה.', means: 'תזכורת in the plural', detected: false,
    note: 'MISS: a suffix, and this table is proclitics only',
  }),
  /* Hebrew — shame */
  Object.freeze({
    locale: 'he', lexicon: 'shame', form: 'affixed',
    text: 'ונכשלת בטיפול בפריט הזה.', means: 'ו + נכשלת', detected: true,
    note: 'conjunction on a listed verb',
  }),
  Object.freeze({
    locale: 'he', lexicon: 'shame', form: 'inflected',
    text: 'הכישלון כאן ברור.', means: 'נכשלת as a derived nominal', detected: false,
    note: 'MISS: a shared root is not a shared prefix',
  }),
  /* English — the inverse coverage gap, and it is #38 to repair */
  Object.freeze({
    locale: 'en', lexicon: 'persistence', form: 'bare',
    text: 'I am keeping track of that one for you.', means: 'keeping track', detected: true,
    note: 'the stored form; the control',
  }),
  Object.freeze({
    locale: 'en', lexicon: 'persistence', form: 'inflected',
    text: 'I logged that one for you.', means: 'logged', detected: true,
    note: "#38's list carries several inflection pairs outright, so this one is covered by the list rather than by any expansion",
  }),
  Object.freeze({
    locale: 'en', lexicon: 'persistence', form: 'inflected',
    text: 'I keep track of that one for you.', means: 'keeping track, uninflected', detected: false,
    note: "MISS: #38's list has `keeping track` and not `keep track`. English declares no clitics, so no expansion reaches it",
  }),
  Object.freeze({
    locale: 'en', lexicon: 'persistence', form: 'inflected',
    text: 'I will keep an eye on that one for you.', means: 'the eye idiom', detected: false,
    note: "MISS, and the inverse coverage gap: this file's Arabic and Hebrew lists carry the eye idiom and #38's English list does not. Repair belongs in #38 — PERSISTENCE_LEXICON.en is #38's array by identity and a local copy would drift",
  }),
  Object.freeze({
    locale: 'en', lexicon: 'persistence', form: 'inflected',
    text: 'I will keep tabs on that one for you.', means: 'the tabs idiom', detected: false,
    note: "MISS: same gap, second idiom. #38's `CREATION_OR_TRACKING_CLAIM` superset stops at single verbs",
  }),
]);

/** The lexicon a probe is measured against. Derived, never listed twice. */
export function lexiconForProbe(probe: MorphologyProbe): readonly string[] {
  return probe.lexicon === 'persistence'
    ? PERSISTENCE_LEXICON[probe.locale]
    : TONE_LEXICON[probe.locale].non_shaming.disqualifying;
}

/**
 * Claim kinds that name something the person can go and do.
 *
 * The structural half of the helpfulness signal: an intent that offers a move
 * and a turn that realizes none of these is unhelpful whatever words it used,
 * and no lexicon can see that. `nothing_to_offer` is deliberately absent —
 * `explain_withholding` is helpful precisely by *not* naming an action, so the
 * signal is applied only to the two intents that offer one.
 */
export const ACTION_BEARING_CLAIM_KINDS = Object.freeze([
  'proposed_action',
  'sole_option',
] as const) satisfies readonly CoachingClaimKind[];

/** The intents a turn is expected to give the person something to do. */
export const ACTION_OFFERING_INTENTS = Object.freeze([
  'present_choice',
  'present_sole_option',
] as const);

/* ── Phrase matching ─────────────────────────────────────────────── */

/**
 * Everything that is not a letter, mark or digit **in the three scripts this
 * evaluation set covers**.
 *
 * Written as explicit ranges rather than `\p{L}\p{M}\p{N}`, because this
 * repository targets ES5 and the Unicode property escapes require an ES6 target
 * and the `u` flag. Spelling the ranges out is the honest form anyway: it says
 * which scripts the matcher actually knows about instead of implying it handles
 * every writing system.
 *
 *   0030–0039, 0041–005A, 0061–007A  ASCII digits and Latin letters
 *   00C0–024F                        Latin-1 supplement and extended
 *   0590–05FF                        Hebrew
 *   0600–06FF                        Arabic
 *   FB1D–FDFF, FE70–FEFF             Hebrew and Arabic presentation forms
 *
 * Not global: `String.prototype.split` splits on every match of a non-global
 * pattern, and a non-global `RegExp` has no `lastIndex` to persist between
 * calls. That is the hazard #38 names for exporting a `RegExp`, avoided by
 * construction rather than by remembering.
 */
const NON_WORD = new RegExp(
  '[^0-9A-Za-z\\u00C0-\\u024F\\u0590-\\u05FF\\u0600-\\u06FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF]+',
);

/**
 * Fold a string to space-delimited word runs, padded, so a phrase test is a
 * substring test with guaranteed boundaries at both ends.
 *
 * `\b` is not usable here: with the `u` flag it is still defined over ASCII word
 * characters, so it fires *inside* a Hebrew or Arabic word and not at its edges.
 * A `\b`-anchored matcher would therefore report hits in the two locales this
 * evaluation set exists to cover, which is worse than not checking them.
 */
function fold(value: string): string {
  return ` ${value.toLowerCase().split(NON_WORD).join(' ').trim()} `;
}

/* ── Affix clitics ───────────────────────────────────────────────── */

/**
 * The proclitics that attach to the front of a word in each locale.
 *
 * ── Why this exists, and what it cost not to have it ──────────────
 *
 * The first version of this file matched phrases exactly after punctuation
 * folding, and the corpus was authored around that: every Arabic and Hebrew
 * adversarial string used a bare, unprefixed form, and the file's own comment
 * said so — "chosen without attached clitics, because the matcher folds on
 * non-letters and a prefixed form would silently not match".
 *
 * That sentence describes a corpus **shaped to be catchable**, in the two
 * languages where affixation is the dominant failure mode. The measured
 * consequence: **0 of 183 rows exercised an affixed or inflected form**, and the
 * `131/131` detection figure was computed over a population selected for
 * detectability. It is the same defect as the generator lockstep, one layer up:
 * the instrument agreed with itself because the inputs were chosen by the same
 * assumption the instrument makes.
 *
 * ── What this covers ──────────────────────────────────────────────
 *
 * Expansion is on the **lexicon**, not on the text. Prefixing the first word of
 * a stored phrase preserves multi-word contiguity; stripping prefixes off the
 * text would break it, because `أبقي عيني على` would have to survive a
 * per-word rewrite. Each locale declares three ordered slots — conjunction,
 * then preposition or future marker, then article — and the expansion is their
 * cartesian product, which is bounded, enumerable, and printable in a review.
 *
 * `en` declares the empty prefix alone. English has no proclitics, and
 * inventing some would be a second morphology nobody asked for. The English
 * residual is real and is *measured* rather than papered over — see
 * `MORPHOLOGY_RESIDUAL`.
 *
 * ── What it does not cover, stated rather than discovered ─────────
 *
 * This is affixation, not morphology. Internal inflection (Arabic broken
 * plurals, Hebrew binyan changes), verb conjugation away from the stored
 * person, Arabic `لل` article assimilation, and Hebrew construct forms all
 * remain missed. `MORPHOLOGY_RESIDUAL` is a probe set that names specific
 * forms in each of those classes and pins which are caught and which are not,
 * so the gap is a number in a report rather than a hope in a comment.
 */
export const AFFIX_CLITICS: Readonly<Record<CoachingLocale, readonly (readonly string[])[]>> =
  Object.freeze({
    en: Object.freeze([Object.freeze([''])]),
    ar: Object.freeze([
      /** Conjunctions. */
      Object.freeze(['', 'و', 'ف']),
      /** Prepositions and the future marker. */
      Object.freeze(['', 'ب', 'ك', 'ل', 'س']),
      /** The definite article. */
      Object.freeze(['', 'ال']),
    ]),
    he: Object.freeze([
      /** The conjunctive vav. */
      Object.freeze(['', 'ו']),
      /** Prepositions and the subordinating shin. */
      Object.freeze(['', 'ש', 'כ', 'ב', 'ל', 'מ']),
      /** The definite he. */
      Object.freeze(['', 'ה']),
    ]),
  });

/**
 * Every affixed spelling of `phrase` in `locale`, first word only.
 *
 * Deterministic and code-point ordered, so an expanded lexicon can be printed
 * in a review and compared between runs. The unprefixed form is always present,
 * because the empty string is a member of every slot.
 */
export function affixVariants(locale: CoachingLocale, phrase: string): readonly string[] {
  if (typeof phrase !== 'string' || phrase.trim().length === 0) return [];
  const slots = AFFIX_CLITICS[locale];
  if (slots === undefined) return [phrase];
  let prefixes: string[] = [''];
  for (let slot = 0; slot < slots.length; slot += 1) {
    const next: string[] = [];
    for (let left = 0; left < prefixes.length; left += 1) {
      for (let right = 0; right < slots[slot].length; right += 1) {
        next.push(prefixes[left] + slots[slot][right]);
      }
    }
    prefixes = next;
  }
  const seen: string[] = [];
  for (let index = 0; index < prefixes.length; index += 1) {
    const variant = `${prefixes[index]}${phrase}`;
    if (!seen.includes(variant)) seen.push(variant);
  }
  return seen.sort(compareByCodePoint);
}

/**
 * Whether `text` contains `phrase` as a whole word run. Total on any input.
 *
 * Exact, with no affix expansion. `matchesPhraseInLocale` is the one the gates
 * use; this stays exported because the expansion has to be testable against the
 * thing it expands, and a matcher that could only be observed through its own
 * expansion could not be shown to have grown teeth.
 */
export function matchesPhrase(text: unknown, phrase: string): boolean {
  if (typeof text !== 'string' || typeof phrase !== 'string') return false;
  const foldedPhrase = fold(phrase);
  if (foldedPhrase.trim().length === 0) return false;
  return fold(text).includes(foldedPhrase);
}

/**
 * Whether `text` contains `phrase` in any spelling `locale` licenses.
 *
 * The matcher the gates use. `matchesPhrase(text, phrase)` implies this, so it
 * is a strict widening: nothing that matched before stops matching.
 */
export function matchesPhraseInLocale(locale: CoachingLocale, text: unknown, phrase: string): boolean {
  const variants = affixVariants(locale, phrase);
  for (let index = 0; index < variants.length; index += 1) {
    if (matchesPhrase(text, variants[index])) return true;
  }
  return false;
}

/**
 * Which entries of `phrases` occur in `text`, in code-point order.
 *
 * Sorted with `compareByCodePoint`, never `localeCompare`: these lists reach a
 * committed report, and `localeCompare`'s answer moves with the host's ICU data
 * and `LANG` — which for an Arabic and Hebrew corpus is not a hypothetical.
 */
export function matchedPhrases(
  locale: CoachingLocale,
  text: unknown,
  phrases: readonly string[],
): readonly string[] {
  const hits: string[] = [];
  for (let index = 0; index < phrases.length; index += 1) {
    // The *stored* phrase is reported, never the affixed spelling that matched.
    // A signal naming the surface form would put a fragment of the judged text
    // into a report field, which is the one direction this repo has a recorded
    // leak in.
    if (matchesPhraseInLocale(locale, text, phrases[index])) hits.push(phrases[index]);
  }
  return hits.sort(compareByCodePoint);
}

function proseOf(output: CoachingOutput): string {
  const sentences = Array.isArray(output?.sentences) ? output.sentences : [];
  const parts: string[] = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const text = sentences[index]?.text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join(' ');
}

/* ── The claim-source resolution this rubric adds ────────────────── */

/**
 * Which claim kind each non-support claim source licenses.
 *
 * #38's `CLAIM_KIND_FOR_SUPPORT_REASON` is total over `SupportReasonCode` and
 * says nothing about the other three `EvidenceClaimSource` kinds, because a
 * planner picks those from the offer's shape rather than from a reason code.
 * This table is **#37's own reading**, it is disjoint from #38's (that one is
 * keyed by reason code, this one by source kind), and it is stated here rather
 * than inlined in a check so a reviewer can disagree with it in one place.
 *
 * - `option_confidence`          — the claim being made about an option's
 *                                  confidence is that the option is the move:
 *                                  `proposed_action`.
 * - `withholding_reason`         — `nothing_to_offer`, the only kind a withheld
 *                                  recommendation licenses.
 * - `only_candidate_attestation` — `sole_option`, which is what the attestation
 *                                  is an attestation *of*.
 *
 * Total over the three, so a source kind added to #38 without a decision here is
 * a compile error.
 */
export const CLAIM_KIND_FOR_NON_SUPPORT_SOURCE = Object.freeze({
  option_confidence: 'proposed_action',
  withholding_reason: 'nothing_to_offer',
  only_candidate_attestation: 'sole_option',
}) satisfies Readonly<Record<Exclude<EvidenceClaimSource['kind'], 'support_reason'>, CoachingClaimKind>>;

/** What a claim source resolves to in the recommendation, or why it does not. */
type SourceResolution =
  | { readonly found: true; readonly evidence: readonly EvidenceNodeId[]; readonly licensedKind: CoachingClaimKind }
  | { readonly found: false };

const NOT_FOUND: SourceResolution = Object.freeze({ found: false });

function resolveClaimSource(
  source: EvidenceClaimSource,
  recommendation: Recommendation,
): SourceResolution {
  if (source === null || source === undefined) return NOT_FOUND;

  if (source.kind === 'withholding_reason') {
    if (recommendation?.outcome !== 'withheld') return NOT_FOUND;
    const reasons = Array.isArray(recommendation.reasons) ? recommendation.reasons : [];
    const reason = reasons[source.reasonIndex];
    if (reason === undefined || reason === null) return NOT_FOUND;
    return {
      found: true,
      evidence: Array.isArray(reason.supportedBy) ? reason.supportedBy : [],
      licensedKind: CLAIM_KIND_FOR_NON_SUPPORT_SOURCE.withholding_reason,
    };
  }

  if (recommendation?.outcome !== 'offered') return NOT_FOUND;

  if (source.kind === 'only_candidate_attestation') {
    const options = recommendation.options;
    if (options === null || options === undefined || options.kind !== 'only_candidate') return NOT_FOUND;
    const attested = Array.isArray(options.attested) ? options.attested : [];
    if (attested.length === 0) return NOT_FOUND;
    return {
      found: true,
      evidence: attested,
      licensedKind: CLAIM_KIND_FOR_NON_SUPPORT_SOURCE.only_candidate_attestation,
    };
  }

  const options = offeredOptions(recommendation.options);
  const option = options[source.optionIndex];
  if (option === undefined || option === null) return NOT_FOUND;

  if (source.kind === 'option_confidence') {
    const basis = Array.isArray(option.confidence?.basis) ? option.confidence.basis : [];
    if (basis.length === 0) return NOT_FOUND;
    return {
      found: true,
      evidence: basis,
      licensedKind: CLAIM_KIND_FOR_NON_SUPPORT_SOURCE.option_confidence,
    };
  }

  const support: readonly SupportReason[] = Array.isArray(option.support) ? option.support : [];
  const reason: SupportReason | undefined = support[source.reasonIndex];
  if (reason === undefined || reason === null) return NOT_FOUND;
  const licensed = CLAIM_KIND_FOR_SUPPORT_REASON[reason.code];
  if (licensed === undefined) return NOT_FOUND;
  return {
    found: true,
    evidence: Array.isArray(reason.supportedBy) ? reason.supportedBy : [],
    licensedKind: licensed,
  };
}

/* ── The faithfulness pass ───────────────────────────────────────── */

/**
 * Everything a rubric evaluation needs about one turn.
 *
 * The recommendation travels with the plan and output because faithfulness is
 * only answerable against it — #38 says the same thing about
 * `checkCoachingOutput` taking the plan rather than re-deriving one, and for the
 * same reason: a checker that rebuilt its reference would be a second producer,
 * right about the same inputs until one of them changed.
 *
 * `currentFingerprints` is what `evaluateRecommendationStaleness` needs. It is
 * supplied rather than derived so a row can express a source that moved, and so
 * this module has no step that reads anything outside its inputs.
 */
export interface RubricInput {
  readonly plan: CoachingPlan;
  readonly output: CoachingOutput;
  readonly recommendation: Recommendation;
  readonly currentFingerprints: Readonly<Record<EvidenceNodeId, string | null>>;
}

function defect(
  code: CoachingDefectCode,
  claimIndex: number | null,
  sentenceIndex: number | null,
  detail: string,
): CoachingDefect {
  return { code, claimIndex, sentenceIndex, detail };
}

/**
 * The faithfulness questions only the recommendation can answer.
 *
 * This is the check #38's contract describes `lib/coaching/validator/` doing and
 * that directory is another track's. Two consequences, both stated rather than
 * discovered:
 *
 *   - It speaks #38's vocabulary — it returns `CoachingDefect`s carrying
 *     `CoachingFaithfulnessDefectCode`s and invents none of its own — so the day
 *     #38's validator lands, replacing this function's body with a delegation is
 *     a one-line change and nothing downstream of it moves.
 *   - Until then this is a **second reader of the same judgement**, which is the
 *     one kind of duplication Sprint 06's lesson permits: two implementations of
 *     one judgement are a check on each other *when something compares them*.
 *     The cross-track comparison is the merge's to write; this file's job is to
 *     be comparable, which is why it emits codes rather than booleans.
 *
 * Reports, never throws, for any input — `COACHING_INPUT_POLICY`'s rule, which
 * Sprint 07 shipped three violations of and Sprint 08 five.
 */
export function checkCoachingFaithfulness(input: RubricInput): readonly CoachingDefect[] {
  const defects: CoachingDefect[] = [];
  const safe = input === null || input === undefined ? ({} as RubricInput) : input;
  const plan = safe.plan ?? ({} as CoachingPlan);
  const output = safe.output ?? ({} as CoachingOutput);
  const recommendation = safe.recommendation ?? (null as unknown as Recommendation);

  if (recommendation === null || recommendation === undefined) {
    defects.push(defect('RECOMMENDATION_MISMATCH', null, null, 'no recommendation was supplied to check against'));
    return defects;
  }

  if (
    plan.recommendationId !== recommendation.recommendationId ||
    output.recommendationId !== recommendation.recommendationId
  ) {
    defects.push(
      defect('RECOMMENDATION_MISMATCH', null, null, 'the plan or output names a different recommendation'),
    );
  }

  // Delegated, never re-derived: this module has no second opinion about what a
  // well-formed evidence graph is.
  defects.push(...checkCarriedEvidence(output.evidence));

  const claims: readonly CoachingClaim[] = Array.isArray(output.claims) ? output.claims : [];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    if (claim === null || claim === undefined || typeof claim !== 'object') continue;

    if (!isEvidenceBackedClaim(claim)) {
      // `checkCoachingPlan` already decides `DECISION_CLAIM_WITHOUT_DECISION`
      // and `DECISION_CLAIM_VERDICT_MISMATCH` against the plan, and re-deciding
      // them here would be a second opinion about the one claim variant #38
      // calls the worst thing this module could emit.
      //
      // What it does **not** decide is whether the echoed *kind* is the one the
      // echoed verdict licenses. `checkCoachingPlan` checks that the kind is
      // some decision-echo kind and that the verdict matches the plan's; a claim
      // reading `kind: 'user_completed'` on a `verdict: 'accept'` the plan does
      // acknowledge satisfies both and still tells the person they marked
      // something done when they only accepted an offer. That is the fabricated
      // completion #38 says is one field away from a correct output, and this is
      // the field. Decided against `CLAIM_KIND_FOR_DECISION_VERDICT`, which is
      // #38's own table, so this is a missing *call site* rather than a second
      // opinion.
      const verdict = claim.source?.verdict;
      const licensed = CLAIM_KIND_FOR_DECISION_VERDICT[verdict];
      if (licensed !== undefined && claim.kind !== licensed) {
        defects.push(
          defect(
            'CLAIM_KIND_NOT_DERIVABLE',
            index,
            null,
            'the decision echo asserts a kind the echoed verdict does not license',
          ),
        );
      }
      continue;
    }

    const resolution = resolveClaimSource(claim.source, recommendation);
    if (!resolution.found) {
      defects.push(
        defect('UNKNOWN_SOURCE_REASON', index, null, 'the claim names a position the recommendation does not have'),
      );
      continue;
    }

    if (claim.kind !== resolution.licensedKind) {
      defects.push(
        defect(
          'CLAIM_KIND_NOT_DERIVABLE',
          index,
          null,
          'the claim asserts a kind the reason it cites does not license',
        ),
      );
    }

    const cited: readonly EvidenceNodeId[] = Array.isArray(claim.supportedBy) ? claim.supportedBy : [];
    for (let cursor = 0; cursor < cited.length; cursor += 1) {
      const nodeId = cited[cursor];
      if (!resolution.evidence.includes(nodeId)) {
        // The load-bearing one. Sprint 08's checkers structurally cannot find
        // this: every id here is a valid node of a valid graph.
        defects.push(
          defect(
            'CLAIM_EVIDENCE_NOT_IN_REASON',
            index,
            null,
            `evidence reference ${cursor} is not one the source reason cites`,
          ),
        );
      }
      const roots: readonly ObservedEvidence[] | null = resolveEvidenceRoots(output.evidence, nodeId);
      if (roots === null || roots.length === 0) {
        defects.push(
          defect(
            'UNRESOLVABLE_EVIDENCE',
            index,
            null,
            `evidence reference ${cursor} reaches no observation`,
          ),
        );
      }
    }
  }

  const staleness = stalenessReasonCount(recommendation, output.basisAt, safe.currentFingerprints);
  if (staleness !== null) {
    defects.push(
      defect(
        'SOURCE_RECOMMENDATION_STALE',
        null,
        null,
        `the recommendation is not offerable at the basis instant (${staleness} reason(s))`,
      ),
    );
  }

  return defects;
}

/**
 * The staleness count, or null when the recommendation is fresh.
 *
 * `basisAt` is checked with `isInstant` first — imported from
 * `recommendationContracts`, never re-spelled, because a second definition of
 * "what is a valid instant" is a second definition of the offset rule. An
 * unusable basis is reported as staleness rather than silently skipped: a check
 * that cannot run is a check that refuses, which is #39's fail-closed rule.
 */
function stalenessReasonCount(
  recommendation: Recommendation,
  basisAt: Instant,
  fingerprints: Readonly<Record<EvidenceNodeId, string | null>> | undefined,
): number | null {
  if (!isInstant(basisAt)) return 1;
  // Sprint 08's judgement, called, never re-derived.
  const verdict = evaluateRecommendationStaleness({
    recommendation,
    now: basisAt,
    currentFingerprints: fingerprints ?? {},
  });
  return verdict.fresh ? null : verdict.reasons.length;
}

/* ── The language pass ───────────────────────────────────────────── */

/**
 * The prose checks this rubric owns.
 *
 * **The scaffold half of `COACHING_FORBIDDEN_LANGUAGE` is deliberately not
 * checked here.** `tracking`, `drafted`, `executed`, `disposition`, `raw output`
 * and the rest are internal scaffolding leaking into user copy — a presentation
 * defect that #38's validator owns and that is neither a tone dimension nor a
 * faithfulness one. Checking it here would put a third opinion about #38's
 * lexicon into the repo for a code this rubric has no gate for. Named as an
 * exclusion rather than left as an omission nothing notices, on Sprint 08's
 * terms.
 *
 * `identifiers` is the set of caller-chosen strings that must not reach prose.
 * They are supplied by the corpus row rather than scraped from the
 * recommendation inside this function, because the row is the only thing that
 * knows which of its ids are supposed to be secret.
 */
export function checkCoachingLanguage(
  output: CoachingOutput,
  identifiers: readonly string[],
): readonly CoachingDefect[] {
  const defects: CoachingDefect[] = [];
  const safe = output === null || output === undefined ? ({} as CoachingOutput) : output;
  const locale = safe.locale;
  const known = (COACHING_LOCALES as readonly string[]).includes(locale as string);
  if (!known) return defects;

  const sentences = Array.isArray(safe.sentences) ? safe.sentences : [];
  for (let index = 0; index < sentences.length; index += 1) {
    const text = sentences[index]?.text;
    const shame = TONE_LEXICON[locale as CoachingLocale].non_shaming.disqualifying;
    if (matchedPhrases(locale as CoachingLocale, text, shame).length > 0) {
      defects.push(defect('FORBIDDEN_LANGUAGE', null, index, 'the sentence labels the person rather than the situation'));
    }
    const persistence = PERSISTENCE_LEXICON[locale as CoachingLocale];
    if (matchedPhrases(locale as CoachingLocale, text, persistence).length > 0) {
      defects.push(
        defect(
          'COMPLETION_DESCRIBED_AS_TRACKING',
          null,
          index,
          'the sentence claims the module saved, tracked or will watch something; it performs no writes',
        ),
      );
    }
    for (let cursor = 0; cursor < identifiers.length; cursor += 1) {
      const identifier = identifiers[cursor];
      if (typeof identifier !== 'string' || identifier.length === 0) continue;
      if (typeof text === 'string' && text.includes(identifier)) {
        // The identifier itself never travels in the detail. Sprint 07's leak
        // went out through exactly such a field while a test watched the title.
        defects.push(
          defect('IDENTIFIER_IN_PROSE', null, index, `identifier ${cursor} of the supplied set reached the rendered text`),
        );
        break;
      }
    }
  }
  return defects;
}

/* ── The verdict ─────────────────────────────────────────────────── */

export interface ToneSignal {
  readonly weight: 'disqualifying' | 'cautionary' | 'structural';
  /** The phrase matched, or the structural signal's name. Never user data. */
  readonly signal: string;
}

export interface ToneScore {
  readonly dimension: ToneDimension;
  readonly band: ToneBand;
  readonly signals: readonly ToneSignal[];
}

export interface FaithfulnessFinding {
  readonly dimension: FaithfulnessDimension;
  readonly code: CoachingDefectCode;
  readonly claimIndex: number | null;
  readonly sentenceIndex: number | null;
  readonly detail: string;
}

export interface FaithfulnessGateResult {
  readonly outcomeByDimension: Readonly<Record<FaithfulnessDimension, FaithfulnessOutcome>>;
  readonly findings: readonly FaithfulnessFinding[];
}

/**
 * The rubric's answer about one turn.
 *
 * Three variants, strictly ordered, and `tone` exists on the third alone. See
 * the file header: this is the acceptance criterion "faithfulness is a separate
 * gate from tone" expressed as a shape rather than as a convention.
 *
 * `outOfScope` appears on all three because a defect this rubric does not own is
 * still a defect and dropping it would be the quiet direction. It never affects
 * a band or an outcome.
 */
export type RubricVerdict =
  | {
      readonly gate: 'inadmissible';
      readonly structural: readonly CoachingDefect[];
      readonly outOfScope: readonly CoachingDefect[];
    }
  | {
      readonly gate: 'faithfulness_violated';
      readonly faithfulness: FaithfulnessGateResult;
      readonly outOfScope: readonly CoachingDefect[];
    }
  | {
      readonly gate: 'scored';
      readonly faithfulness: FaithfulnessGateResult;
      readonly tone: readonly ToneScore[];
      readonly outOfScope: readonly CoachingDefect[];
    };

/**
 * The tone scores, or `null` when the rubric never reached the tone gate.
 *
 * The single accessor, so an aggregator cannot reach a tone number for a turn
 * whose faithfulness failed even by accident — there is no field to read. This
 * is the enforcement half of the structural separation; the union is the
 * declaration half.
 */
export function toneScoresOf(verdict: RubricVerdict): readonly ToneScore[] | null {
  return verdict !== null && verdict !== undefined && verdict.gate === 'scored' ? verdict.tone : null;
}

function scoreToneDimension(
  dimension: ToneDimension,
  locale: CoachingLocale,
  prose: string,
  structural: readonly ToneSignal[],
): ToneScore {
  const entry = TONE_LEXICON[locale][dimension];
  const signals: ToneSignal[] = [];
  const disqualifying = matchedPhrases(locale, prose, entry.disqualifying);
  for (let index = 0; index < disqualifying.length; index += 1) {
    signals.push({ weight: 'disqualifying', signal: disqualifying[index] });
  }
  const cautionary = matchedPhrases(locale, prose, entry.cautionary);
  for (let index = 0; index < cautionary.length; index += 1) {
    signals.push({ weight: 'cautionary', signal: cautionary[index] });
  }
  for (let index = 0; index < structural.length; index += 1) signals.push(structural[index]);

  // Computed from the whole signal list rather than from the first hit, because
  // the lists are concatenated in a fixed order and a first-hit rule would make
  // the band depend on that order rather than on what was found.
  let sawFail = false;
  let sawCaution = false;
  for (let index = 0; index < signals.length; index += 1) {
    const weight = signals[index].weight;
    if (weight === 'disqualifying' || weight === 'structural') sawFail = true;
    if (weight === 'cautionary') sawCaution = true;
  }
  const band: ToneBand = sawFail ? 'fail' : sawCaution ? 'borderline' : 'pass';
  return { dimension, band, signals };
}

function structuralHelpfulnessSignals(output: CoachingOutput): readonly ToneSignal[] {
  const offersAction = (ACTION_OFFERING_INTENTS as readonly string[]).includes(output.intent as string);
  if (!offersAction) return [];
  const claims: readonly CoachingClaim[] = Array.isArray(output.claims) ? output.claims : [];
  for (let index = 0; index < claims.length; index += 1) {
    const kind = claims[index]?.kind;
    if ((ACTION_BEARING_CLAIM_KINDS as readonly string[]).includes(kind as string)) return [];
  }
  return [{ weight: 'structural', signal: 'no_action_bearing_claim' }];
}

/**
 * Run the rubric over one turn.
 *
 * Ordering is admissibility, then faithfulness, then tone, and each gate is
 * reached only when the one before it held. That order is the acceptance
 * criterion: a turn that says something the recommendation did not is never
 * assigned a tone score at all, so no aggregate can be built in which a warm
 * fabrication outranks a blunt truth.
 *
 * Returns a verdict for any input, including a null one, and reports rather than
 * throws for everything this taxonomy names.
 */
export function evaluateRubric(input: RubricInput): RubricVerdict {
  const safe = input === null || input === undefined ? ({} as RubricInput) : input;
  const plan = safe.plan ?? ({} as CoachingPlan);
  const output = safe.output ?? ({} as CoachingOutput);

  const identifiers = collectIdentifiers(safe);
  const all: CoachingDefect[] = [
    ...checkCoachingPlan(plan),
    ...checkCoachingOutput(output, plan),
    ...checkCoachingFaithfulness(safe),
    ...checkCoachingLanguage(output, identifiers),
  ];

  const structural: CoachingDefect[] = [];
  const outOfScope: CoachingDefect[] = [];
  const findings: FaithfulnessFinding[] = [];
  // Tone-owned defects become tone *signals* rather than a separate list. A
  // defect quietly discarded because the lexicon would have caught it anyway is
  // a defect nothing notices when the lexicon stops catching it.
  const toneDefectSignals: Record<ToneDimension, ToneSignal[]> = {
    helpfulness: [],
    calmness: [],
    non_shaming: [],
  };

  for (let index = 0; index < all.length; index += 1) {
    const item = all[index];
    const disposition = CODE_DISPOSITIONS[item.code];
    if (disposition === undefined) {
      // A code this rubric version does not know. Inadmissible rather than
      // ignored, on `UNKNOWN_NODE_KIND`'s terms: every pass here is written as
      // "if the code is X", so an unrecognised one is silently exempt from all
      // of them and is therefore the ideal place to hide.
      structural.push(item);
      continue;
    }
    if (disposition.kind === 'inadmissible') {
      structural.push(item);
      continue;
    }
    if (disposition.kind === 'out_of_scope') {
      outOfScope.push(item);
      continue;
    }
    if ((FAITHFULNESS_DIMENSIONS as readonly string[]).includes(disposition.dimension)) {
      findings.push({
        dimension: disposition.dimension as FaithfulnessDimension,
        code: item.code,
        claimIndex: item.claimIndex,
        sentenceIndex: item.sentenceIndex,
        detail: item.detail,
      });
      continue;
    }
    toneDefectSignals[disposition.dimension as ToneDimension].push({
      weight: 'disqualifying',
      signal: item.code,
    });
  }

  if (structural.length > 0) {
    return { gate: 'inadmissible', structural, outOfScope };
  }

  const outcomeByDimension = {
    claim_support: 'held',
    claim_derivability: 'held',
    decision_echo_integrity: 'held',
    persistence_claim: 'held',
  } as Record<FaithfulnessDimension, FaithfulnessOutcome>;
  for (let index = 0; index < findings.length; index += 1) {
    outcomeByDimension[findings[index].dimension] = 'violated';
  }
  const faithfulness: FaithfulnessGateResult = { outcomeByDimension: Object.freeze(outcomeByDimension), findings };

  if (findings.length > 0) {
    return { gate: 'faithfulness_violated', faithfulness, outOfScope };
  }

  const locale = output.locale as CoachingLocale;
  const prose = proseOf(output);
  const helpfulnessStructural = structuralHelpfulnessSignals(output);
  const tone: ToneScore[] = [];
  for (let index = 0; index < TONE_DIMENSIONS.length; index += 1) {
    const dimension = TONE_DIMENSIONS[index];
    const extra =
      dimension === 'helpfulness'
        ? [...helpfulnessStructural, ...toneDefectSignals[dimension]]
        : toneDefectSignals[dimension];
    tone.push(scoreToneDimension(dimension, locale, prose, extra));
  }

  return { gate: 'scored', faithfulness, tone, outOfScope };
}

/**
 * The caller-chosen strings that must not appear in prose.
 *
 * Gathered from the recommendation and the plan rather than from a list the row
 * supplies, so a row cannot pass the identifier check by forgetting to declare
 * one of its own ids. Every one of these is a free string a person filled with
 * content; #38's recorded leak was a detail reading
 * `working window call-dr.cohen-about-the-biopsy`.
 */
function collectIdentifiers(input: RubricInput): readonly string[] {
  const found: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0 && !found.includes(value)) found.push(value);
  };
  const recommendation = input.recommendation;
  if (recommendation !== null && recommendation !== undefined) {
    push(recommendation.recommendationId);
    push(recommendation.scopeId);
    if (recommendation.outcome === 'offered') {
      const summary = summarizeOptionSet(recommendation.options);
      const actions: unknown[] = [];
      const offered = offeredOptions(recommendation.options);
      for (let index = 0; index < offered.length; index += 1) actions.push(offered[index]?.action);
      // Excluded options too. Their `commitmentId` is a caller-chosen free
      // string exactly as an offered one is, and a turn that named the thing
      // the module decided *not* to propose has leaked the same kind of value.
      // Reading only the offered side was a hole with no test over it.
      for (let index = 0; index < summary.excluded.length; index += 1) {
        actions.push(summary.excluded[index]?.action);
      }
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        if (action === null || action === undefined) continue;
        push((action as { commitmentId?: unknown }).commitmentId);
        push((action as { proposalId?: unknown }).proposalId);
      }
    }
    const nodes = Array.isArray(recommendation.evidence?.nodes) ? recommendation.evidence.nodes : [];
    for (let index = 0; index < nodes.length; index += 1) push(nodes[index]?.nodeId);
  }
  return found.sort(compareByCodePoint);
}

/**
 * Which of #38's codes this rubric can ever attribute to a dimension.
 *
 * Derived from `CODE_DISPOSITIONS`, never listed again, so "every dimension is
 * reachable from at least one code" is a question a test can ask of the table
 * rather than of a second list that would drift from it.
 */
export function codesForDimension(dimension: RubricDimension): readonly CoachingDefectCode[] {
  return COACHING_DEFECT_CODES.filter((code) => {
    const disposition = CODE_DISPOSITIONS[code];
    return disposition.kind === 'dimension' && disposition.dimension === dimension;
  });
}
