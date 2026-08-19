/**
 * The coaching evaluation scorer and its report (Sprint 09, issue #37).
 *
 * ── What is real here and what is a slot ─────────────────────────────────
 *
 * #37 asks for an "automated plus human scoring report". The automated half is
 * complete: it runs the rubric over every row, reports per-dimension figures
 * with their denominators, and checks each row against the defect its
 * adversarial category was built to plant. The human half **is a typed, empty
 * slot** — no reviewer exists, nothing here is labelled reviewed, and
 * `HumanSection` in the `not_collected` state carries **no numeric field of any
 * kind**.
 *
 * That last sentence is the design. The required property is that "no human
 * scores yet" is distinguishable from "human scores were all zero", and a
 * `humanScore: number` defaulting to 0 makes those the same value forever — the
 * shape in which an absence of evidence gets rendered as a measured result. So
 * `HumanSection` is a two-variant union discriminated on `status`, and the
 * variant that has nothing to report has nowhere to report it. `mergeHumanScores`
 * is the one function that can move a report from the first to the second, and it
 * needs actual rows to do it.
 *
 * ── Every number carries its denominator ─────────────────────────────────
 *
 * `CoachingMetric` has no field for a bare number. A faithfulness of 1.0 over
 * 3 of 183 rows and a faithfulness of 1.0 over 183 are different claims that
 * become the same claim the moment the value is copied without the count, and
 * the smaller one flatters. A ratio over zero is `null`, never `0`: zero is a
 * measurement and an empty denominator is the absence of one.
 *
 * This is the discipline `lib/decomposition/evaluation/metrics.ts` states for
 * `MetricScore` and `lib/priority/rubric/agreementReport.ts` for its agreement
 * figures. It is **re-declared rather than imported**, and that is a deliberate
 * cost: a coaching module importing another sprint's evaluation module would put
 * one track's code inside another's closure, which
 * `tests/decomposition/boundaryImportClosure.test.ts` exists to prevent. What is
 * duplicated is a *convention* plus a two-line ratio, not a judgement — and the
 * ratio's one interesting decision (zero denominator is `null`) is stated in both
 * places rather than assumed in either.
 *
 * ── The two halves are never combined ────────────────────────────────────
 *
 * There is no `overall`, no `composite`, no weighted total anywhere in this
 * report, and no field that reads a tone figure and a faithfulness figure
 * together. That is not a convention: `RubricVerdict` only carries `tone` on the
 * variant where faithfulness held, so a row that lied has no tone number for an
 * aggregate to reach. `tests/coaching/scoringPipeline.test.ts` proves it by
 * measurement rather than by inspection — it scores two corpora that differ only
 * in the *prose* of their faithfulness-violated rows and asserts the entire
 * faithfulness section is identical.
 *
 * ── The locked half is entered deliberately ──────────────────────────────
 *
 * `scoreTuningSet` takes a `TuningRowSet` and `runLockedEvaluation` takes a
 * `LockedRowSet`, so which half is being measured is a decision visible at the
 * call site rather than an argument someone forgot to filter. The locked entry
 * carries `lib/priority/calibration/lockedGate.ts`' two refusals, for its
 * reasons: a second look at a held-out set is optimisation against the test set
 * performed one attempt at a time, and a gate that reports a pass over zero rows
 * converts an absence of evidence into displayed confidence.
 *
 * No function here reads the system clock. `generatedAt` is always supplied.
 */
import {
  COACHING_DEFECT_CODES,
  type CoachingDefectCode,
  type CoachingLocale,
} from '../../../src/contracts/v1/coachingContracts';
import { isInstant, type Instant } from '../../../src/contracts/v1/recommendationContracts';
import { compareByCodePoint } from '../../planning/shared/compare';
import {
  ADVERSARIAL_CATEGORIES,
  COACHING_EVALUATION_SET_VERSION,
  auditTuningSet,
  corpusDigest,
  verifyLockState,
  type AdversarialCategory,
  type AnnotationProvenance,
  type CoachingEvaluationRow,
  type ExpectedGate,
  type CorpusReviewStatus,
  type LockStateFinding,
  type LockedRowSet,
  type TuningRowSet,
} from './evaluationSet';
import {
  COACHING_RUBRIC,
  COACHING_RUBRIC_VERSION,
  FAITHFULNESS_DIMENSIONS,
  RUBRIC_DIMENSIONS,
  TONE_BANDS,
  TONE_DIMENSIONS,
  evaluateRubric,
  toneScoresOf,
  type FaithfulnessDimension,
  type RubricDimension,
  type RubricVerdict,
  type ToneBand,
  type ToneDimension,
} from './rubric';

export const COACHING_SCORE_REPORT_VERSION = '1.0.0' as const;

/* ── Metrics ─────────────────────────────────────────────────────── */

/**
 * A ratio that cannot be quoted without its denominator.
 *
 * `describes` is a sentence naming what the denominator counts. A number
 * without it is not a claim — the recorded case is a coverage figure of 1.0
 * that meant "the one row we could score was fine".
 */
export interface CoachingMetric {
  readonly metric: string;
  /** `numerator / denominator`, or null when the denominator is zero. */
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly describes: string;
}

function metric(name: string, numerator: number, denominator: number, describes: string): CoachingMetric {
  return {
    metric: name,
    // Null, never 0. Zero is "nothing was faithful"; an empty denominator is
    // "nothing was measured", and rendering the second as the first presents no
    // data as a bad result.
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
    describes,
  };
}

/* ── Per-row scoring ─────────────────────────────────────────────── */

/**
 * One row's result.
 *
 * `rowIndex` rather than `rowId` is what travels into any human-readable
 * `detail` below. The id is kept as a field a consumer may render or drop, on
 * `SafetyFinding`'s terms: a row id is a caller-chosen free string and this
 * repository has a recorded leak through exactly such a field.
 */
export interface RowScore {
  readonly rowIndex: number;
  readonly rowId: string;
  readonly locale: CoachingLocale;
  readonly category: AdversarialCategory;
  readonly verdict: RubricVerdict;
  readonly expectedGate: ExpectedGate;
  readonly gateMatchedExpectation: boolean;
  /**
   * Whether the dimension this category was built to break is the one that
   * broke. Null when the category attacks no rubric dimension —
   * `clean_control` and `identifier_in_prose`, where the correct answer is
   * "nothing this rubric owns".
   */
  readonly attackedDimensionDetected: boolean | null;
}

export function scoreRow(row: CoachingEvaluationRow, rowIndex: number): RowScore {
  const verdict = evaluateRubric(row.input);
  const expected = row.expectation.expectedGate;
  const attacks = row.expectation.attacks;

  let detected: boolean | null = null;
  if (attacks !== null) {
    if ((FAITHFULNESS_DIMENSIONS as readonly string[]).includes(attacks)) {
      detected =
        verdict.gate !== 'inadmissible' &&
        verdict.faithfulness.outcomeByDimension[attacks as FaithfulnessDimension] === 'violated';
    } else {
      const tone = toneScoresOf(verdict);
      detected =
        tone !== null &&
        tone.some((score) => score.dimension === (attacks as ToneDimension) && score.band !== 'pass');
    }
  }

  return {
    rowIndex,
    rowId: row.rowId,
    locale: row.locale,
    category: row.category,
    verdict,
    expectedGate: expected,
    gateMatchedExpectation: verdict.gate === expected,
    attackedDimensionDetected: detected,
  };
}

/* ── Report sections ─────────────────────────────────────────────── */

export interface FaithfulnessSection {
  /** Rows whose faithfulness gate held, over rows that reached it. */
  readonly gateHeld: CoachingMetric;
  readonly byDimension: Readonly<Record<FaithfulnessDimension, CoachingMetric>>;
  /** One entry per #38 code that fired, in code-point order. Counts, not rows. */
  readonly findingCounts: readonly { readonly code: CoachingDefectCode; readonly count: number }[];
}

export interface ToneDimensionSummary {
  readonly passRate: CoachingMetric;
  readonly bandCounts: Readonly<Record<ToneBand, number>>;
}

export interface ToneSection {
  readonly scoredRows: number;
  /**
   * Rows the tone gate was never applied to because faithfulness failed.
   *
   * Named rather than folded into the denominator, and this is the field that
   * makes the separation legible in a stored report: a reader can see that 108
   * turns were never assigned a tone score, instead of seeing a tone figure over
   * 183 rows and having to know which of them lied.
   */
  readonly withheldForFaithfulness: number;
  /** Rows the tone gate was never applied to because the turn was malformed. */
  readonly withheldAsInadmissible: number;
  readonly byDimension: Readonly<Record<ToneDimension, ToneDimensionSummary>>;
}

export interface ExpectationMismatch {
  readonly rowIndex: number;
  readonly category: AdversarialCategory;
  readonly locale: CoachingLocale;
  readonly measuredGate: RubricVerdict['gate'];
  readonly expectedGate: ExpectedGate;
}

/**
 * Whether the corpus still does what it says it does.
 *
 * `attackDetected` is the figure that matters most and it is the one a
 * regression would move first: if the scorer stops detecting a category, this
 * drops while every other number in the report gets *better*. Sprint 06's
 * recorded shape is the same — a decomposer that refused all eleven golden rows
 * scored a perfect faithfulness — and the repair in both cases is the same, a
 * denominator that counts what was supposed to be found rather than what was.
 */
export interface ExpectationSection {
  readonly gateMatched: CoachingMetric;
  readonly attackDetected: CoachingMetric;
  readonly mismatches: readonly ExpectationMismatch[];
  /** Categories with no row at all in this half. Named so an empty one is visible. */
  readonly absentCategories: readonly AdversarialCategory[];
}

export type ReportGuardCode = LockStateFinding['code'] | 'GENERATED_AT_NOT_AN_INSTANT';

export interface ReportGuardFinding {
  readonly code: ReportGuardCode;
  readonly rowIndex: number | null;
  readonly detail: string;
}

/* ── The human slot ──────────────────────────────────────────────── */

/**
 * A reviewer's answer for one dimension of one row.
 *
 * The scale is `ToneBand`'s three values for every dimension, tone and
 * faithfulness alike, so a reviewer's sheet and the automated report can be
 * compared without a translation table. That the *automated* faithfulness gate
 * is binary and the human one is three-valued is deliberate: a reviewer can say
 * "I am not sure this claim traces", and forcing that into held/violated would
 * make an abstention look like a verdict. `lib/decomposition/evaluation/corpus.ts`
 * makes the same allowance and records the reason — treating an abstention as a
 * disagreement pushes a reviewer to guess rather than abstain.
 */
export interface HumanRowScore {
  readonly rowId: string;
  readonly reviewerId: string;
  readonly dimension: RubricDimension;
  readonly verdict: ToneBand;
}

export interface HumanScoreSet {
  /** Supplied by the caller. Nothing here reads a clock. */
  readonly collectedAt: Instant;
  readonly scores: readonly HumanRowScore[];
}

/**
 * What has to arrive before the human half of this report can exist.
 *
 * Data rather than a paragraph in a document, so the report itself carries the
 * instructions for filling its own gap and the two cannot drift. `questions` is
 * read straight off `COACHING_RUBRIC`, never restated.
 */
export interface HumanScoringSlot {
  readonly status: 'awaiting_first_review';
  readonly rubricVersion: typeof COACHING_RUBRIC_VERSION;
  readonly scale: readonly ToneBand[];
  readonly dimensions: readonly RubricDimension[];
  readonly questions: Readonly<Record<RubricDimension, string>>;
  readonly mergeEntryPoint: 'mergeHumanScores';
  readonly note: string;
}

export function humanScoringSlot(): HumanScoringSlot {
  const questions = {} as Record<RubricDimension, string>;
  for (let index = 0; index < RUBRIC_DIMENSIONS.length; index += 1) {
    const dimension = RUBRIC_DIMENSIONS[index];
    questions[dimension] = COACHING_RUBRIC[dimension].humanQuestion;
  }
  return {
    status: 'awaiting_first_review',
    rubricVersion: COACHING_RUBRIC_VERSION,
    scale: TONE_BANDS,
    dimensions: RUBRIC_DIMENSIONS,
    questions: Object.freeze(questions),
    mergeEntryPoint: 'mergeHumanScores',
    note:
      'No review has been collected. Every automated tone figure in this report is a lexical proxy ' +
      '(see automatedIsProxy on each rubric dimension); the faithfulness figures are not. ' +
      'Pass a HumanScoreSet to mergeHumanScores to replace this slot with measured figures. ' +
      'Nothing in this corpus may be described as reviewed until that has happened.',
  };
}

/**
 * The human half of the report.
 *
 * The `not_collected` variant carries **no numeric field**, which is the whole
 * point: "no human scores yet" and "human scores were all zero" must not be the
 * same value, and a nullable number or a zero-initialised counter makes them
 * exactly that. This is `DecisionEchoClaim`'s device and `RubricVerdict`'s: the
 * variant that has nothing to say has nowhere to say it.
 */
export type HumanSection =
  | { readonly status: 'not_collected'; readonly slot: HumanScoringSlot }
  | {
      readonly status: 'collected';
      readonly collectedAt: Instant;
      readonly reviewerCount: number;
      readonly rowsReviewed: number;
      /** Pass rate per dimension, over the reviewed rows only. */
      readonly byDimension: Readonly<Record<RubricDimension, CoachingMetric>>;
      /** Where the reviewer and the automated band agreed, per tone dimension. */
      readonly agreementWithAutomated: Readonly<Record<ToneDimension, CoachingMetric>>;
    };

/* ── The report ──────────────────────────────────────────────────── */

export interface CoachingScoreReport {
  readonly reportVersion: typeof COACHING_SCORE_REPORT_VERSION;
  readonly rubricVersion: typeof COACHING_RUBRIC_VERSION;
  readonly evaluationSetVersion: typeof COACHING_EVALUATION_SET_VERSION;
  /** Supplied by the caller. This module never reads a clock. */
  readonly generatedAt: Instant;
  /** Which half of the corpus this report is about. Never both. */
  readonly half: 'tuning' | 'locked';
  readonly corpusDigest: string;
  /** Carried from the rows, and single-valued by type. See `evaluationSet.ts`. */
  readonly provenance: AnnotationProvenance;
  readonly reviewStatus: CorpusReviewStatus;
  readonly rowCount: number;
  readonly guardFindings: readonly ReportGuardFinding[];
  /** Rows the rubric could be applied to at all, over all rows. */
  readonly admissible: CoachingMetric;
  readonly faithfulness: FaithfulnessSection;
  readonly tone: ToneSection;
  /** Defects a different gate owns, counted so they are not lost. */
  readonly outOfScope: readonly { readonly code: CoachingDefectCode; readonly count: number }[];
  readonly expectation: ExpectationSection;
  readonly human: HumanSection;
  readonly rows: readonly RowScore[];
}

function countByCode(
  codes: readonly CoachingDefectCode[],
): readonly { readonly code: CoachingDefectCode; readonly count: number }[] {
  const counts: { code: CoachingDefectCode; count: number }[] = [];
  for (let index = 0; index < COACHING_DEFECT_CODES.length; index += 1) {
    const code = COACHING_DEFECT_CODES[index];
    let total = 0;
    for (let cursor = 0; cursor < codes.length; cursor += 1) if (codes[cursor] === code) total += 1;
    if (total > 0) counts.push({ code, count: total });
  }
  // Code-point order, never localeCompare: this report is a committed artifact
  // and localeCompare's answer moves with the host's ICU data and LANG.
  return counts.slice().sort((left, right) => compareByCodePoint(left.code, right.code));
}

/**
 * Score a list of rows. The two public entry points differ only in which half
 * they will accept and what they refuse; the arithmetic is here, once.
 */
function buildReport(
  rows: readonly CoachingEvaluationRow[],
  half: 'tuning' | 'locked',
  generatedAt: Instant,
  guardFindings: readonly ReportGuardFinding[],
): CoachingScoreReport {
  const scores: RowScore[] = [];
  for (let index = 0; index < rows.length; index += 1) scores.push(scoreRow(rows[index], index));

  let admissibleCount = 0;
  let faithfulnessHeld = 0;
  let inadmissible = 0;
  let faithfulnessViolated = 0;
  const dimensionHeld = {} as Record<FaithfulnessDimension, number>;
  for (let index = 0; index < FAITHFULNESS_DIMENSIONS.length; index += 1) {
    dimensionHeld[FAITHFULNESS_DIMENSIONS[index]] = 0;
  }
  const faithfulnessCodes: CoachingDefectCode[] = [];
  const outOfScopeCodes: CoachingDefectCode[] = [];
  const bandCounts = {} as Record<ToneDimension, Record<ToneBand, number>>;
  for (let index = 0; index < TONE_DIMENSIONS.length; index += 1) {
    bandCounts[TONE_DIMENSIONS[index]] = { fail: 0, borderline: 0, pass: 0 };
  }
  let toneScoredRows = 0;

  for (let index = 0; index < scores.length; index += 1) {
    const verdict = scores[index].verdict;
    for (let cursor = 0; cursor < verdict.outOfScope.length; cursor += 1) {
      outOfScopeCodes.push(verdict.outOfScope[cursor].code);
    }
    if (verdict.gate === 'inadmissible') {
      inadmissible += 1;
      continue;
    }
    admissibleCount += 1;
    for (let cursor = 0; cursor < FAITHFULNESS_DIMENSIONS.length; cursor += 1) {
      const dimension = FAITHFULNESS_DIMENSIONS[cursor];
      if (verdict.faithfulness.outcomeByDimension[dimension] === 'held') dimensionHeld[dimension] += 1;
    }
    for (let cursor = 0; cursor < verdict.faithfulness.findings.length; cursor += 1) {
      faithfulnessCodes.push(verdict.faithfulness.findings[cursor].code);
    }
    if (verdict.gate === 'faithfulness_violated') {
      faithfulnessViolated += 1;
      continue;
    }
    faithfulnessHeld += 1;
    toneScoredRows += 1;
    for (let cursor = 0; cursor < verdict.tone.length; cursor += 1) {
      const score = verdict.tone[cursor];
      bandCounts[score.dimension][score.band] += 1;
    }
  }

  const byFaithfulnessDimension = {} as Record<FaithfulnessDimension, CoachingMetric>;
  for (let index = 0; index < FAITHFULNESS_DIMENSIONS.length; index += 1) {
    const dimension = FAITHFULNESS_DIMENSIONS[index];
    byFaithfulnessDimension[dimension] = metric(
      `faithfulness.${dimension}`,
      dimensionHeld[dimension],
      admissibleCount,
      'rows the rubric could be applied to',
    );
  }

  const byToneDimension = {} as Record<ToneDimension, ToneDimensionSummary>;
  for (let index = 0; index < TONE_DIMENSIONS.length; index += 1) {
    const dimension = TONE_DIMENSIONS[index];
    byToneDimension[dimension] = {
      passRate: metric(
        `tone.${dimension}`,
        bandCounts[dimension].pass,
        toneScoredRows,
        'rows that reached the tone gate, which excludes every row whose faithfulness failed',
      ),
      bandCounts: Object.freeze({ ...bandCounts[dimension] }),
    };
  }

  let gateMatched = 0;
  let attackDetected = 0;
  let attackAttempts = 0;
  const mismatches: ExpectationMismatch[] = [];
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index];
    if (score.gateMatchedExpectation) gateMatched += 1;
    else {
      mismatches.push({
        rowIndex: index,
        category: score.category,
        locale: score.locale,
        measuredGate: score.verdict.gate,
        expectedGate: score.expectedGate,
      });
    }
    if (score.attackedDimensionDetected !== null) {
      attackAttempts += 1;
      if (score.attackedDimensionDetected) attackDetected += 1;
    }
  }

  const present: AdversarialCategory[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!present.includes(rows[index].category)) present.push(rows[index].category);
  }
  const absent = ADVERSARIAL_CATEGORIES.filter((category) => !present.includes(category));

  return {
    reportVersion: COACHING_SCORE_REPORT_VERSION,
    rubricVersion: COACHING_RUBRIC_VERSION,
    evaluationSetVersion: COACHING_EVALUATION_SET_VERSION,
    generatedAt,
    half,
    corpusDigest: corpusDigest(rows),
    provenance: 'synthetic',
    reviewStatus: 'not_reviewed',
    rowCount: rows.length,
    guardFindings,
    admissible: metric('admissible', admissibleCount, rows.length, 'rows in this half of the corpus'),
    faithfulness: {
      gateHeld: metric(
        'faithfulness.gateHeld',
        faithfulnessHeld,
        admissibleCount,
        'rows the rubric could be applied to',
      ),
      byDimension: Object.freeze(byFaithfulnessDimension),
      findingCounts: countByCode(faithfulnessCodes),
    },
    tone: {
      scoredRows: toneScoredRows,
      withheldForFaithfulness: faithfulnessViolated,
      withheldAsInadmissible: inadmissible,
      byDimension: Object.freeze(byToneDimension),
    },
    outOfScope: countByCode(outOfScopeCodes),
    expectation: {
      gateMatched: metric('expectation.gateMatched', gateMatched, rows.length, 'rows in this half of the corpus'),
      attackDetected: metric(
        'expectation.attackDetected',
        attackDetected,
        attackAttempts,
        'rows whose category names a rubric dimension it was built to break',
      ),
      mismatches,
      absentCategories: absent,
    },
    // The one state a fresh report can be in. See `HumanSection`.
    human: { status: 'not_collected', slot: humanScoringSlot() },
    rows: scores,
  };
}

function guardFindingsFrom(
  lockFindings: readonly LockStateFinding[],
  generatedAt: Instant,
): readonly ReportGuardFinding[] {
  const findings: ReportGuardFinding[] = lockFindings.map((finding) => ({
    code: finding.code,
    rowIndex: finding.rowIndex,
    detail: finding.detail,
  }));
  if (!isInstant(generatedAt)) {
    // `isInstant` from `recommendationContracts`, imported, never re-spelled: a
    // second definition of "what is a valid instant" is a second definition of
    // the offset rule.
    findings.push({
      code: 'GENERATED_AT_NOT_AN_INSTANT',
      rowIndex: null,
      detail: 'generatedAt does not carry an explicit offset; the report cannot be placed in time',
    });
  }
  return findings;
}

/**
 * Score the tuning half.
 *
 * Takes a `TuningRowSet` rather than an array, so handing it the locked half is
 * a type error at the call site. It then re-derives every row's lock state
 * anyway, because a `TuningRowSet` is a plain object and the type only stops the
 * accident — and it **reports** what it finds rather than throwing, on
 * `COACHING_INPUT_POLICY.reportWhatTheTaxonomyNames`' terms. A report carrying a
 * `LOCKED_ROW_IN_TUNING_SET` finding is a report that says its own numbers are
 * contaminated.
 */
export function scoreTuningSet(set: TuningRowSet, generatedAt: Instant): CoachingScoreReport {
  const rows = set === null || set === undefined ? [] : set.rows;
  const findings = [...auditTuningSet(set), ...verifyLockState(rows)];
  return buildReport(rows, 'tuning', generatedAt, guardFindingsFrom(findings, generatedAt));
}

/* ── The locked half ─────────────────────────────────────────────── */

export type LockedRunOutcome = 'measured' | 'refused_already_used' | 'refused_empty_corpus';

export interface LockedRun {
  readonly outcome: LockedRunOutcome;
  /** Null on a refusal: there is no report of a measurement that did not happen. */
  readonly report: CoachingScoreReport | null;
  readonly reason: string;
  /** The ledger after this call: unchanged on a refusal, appended otherwise. */
  readonly usedLockIds: readonly string[];
}

export interface LockedRunInput {
  /** Identity of the locked-half *version*, matching `LOCK_ASSIGNMENT_VERSION`. */
  readonly lockId: string;
  readonly set: LockedRowSet;
  readonly generatedAt: Instant;
  /** Ledger of ids already spent. Supplied by the caller; this module stores nothing. */
  readonly usedLockIds: readonly string[];
}

/**
 * Measure the locked half, once.
 *
 * Both refusals are `lib/priority/calibration/lockedGate.ts`', adopted rather
 * than reinvented, and both are checked **before** anything is measured so a
 * re-run cannot present itself as some other kind of non-answer:
 *
 *   - `refused_already_used` — measuring against a held-out set spends it. After
 *     the first look it is no longer held out, and a second run is optimisation
 *     against the test set performed one attempt at a time.
 *   - `refused_empty_corpus` — a report over zero rows emits the same words a
 *     real one emits and certifies nothing, so it converts an absence of
 *     evidence into displayed confidence.
 *
 * A refusal does not consume the id, because nothing was measured. A successful
 * run consumes it whatever the numbers say — if a bad result were free to
 * re-run, the cheapest response to one would be a small change and another look,
 * which is the leak this mechanism exists to close.
 */
export function runLockedEvaluation(input: LockedRunInput): LockedRun {
  const { lockId, set, generatedAt, usedLockIds } = input;
  const rows = set === null || set === undefined ? [] : set.rows;

  if (typeof lockId !== 'string' || lockId.length === 0) {
    return {
      outcome: 'refused_already_used',
      report: null,
      reason: 'an unnamed locked half cannot be recorded as used, so it cannot be measured',
      usedLockIds,
    };
  }
  if (usedLockIds.includes(lockId)) {
    return {
      outcome: 'refused_already_used',
      report: null,
      reason:
        'this locked half has already been measured; a second look at a held-out set is optimisation against the test set',
      usedLockIds,
    };
  }
  if (rows.length === 0) {
    return {
      outcome: 'refused_empty_corpus',
      report: null,
      reason:
        'the locked half carries no rows; a report over zero rows would manufacture confidence rather than measure it',
      usedLockIds,
    };
  }

  const findings = verifyLockState(rows);
  return {
    outcome: 'measured',
    report: buildReport(rows, 'locked', generatedAt, guardFindingsFrom(findings, generatedAt)),
    reason: `measured ${rows.length} locked row(s)`,
    usedLockIds: [...usedLockIds, lockId],
  };
}

/* ── Merging human scores ────────────────────────────────────────── */

/**
 * Replace a report's empty human slot with measured human figures.
 *
 * The **only** way a report reaches `status: 'collected'`, and it needs rows to
 * do it: an empty `HumanScoreSet` produces a `not_collected` section back, not a
 * `collected` one full of zeros. That is the required distinction expressed as
 * behaviour rather than as a comment — "no human scores yet" and "human scores
 * were all zero" reach different variants, and the first one has no number in it
 * to be mistaken for the second.
 *
 * `agreementWithAutomated` is the figure this whole track exists to eventually
 * produce: it is the only thing that can say whether the lexical proxies in the
 * tone gate are worth anything. It is computed only over tone dimensions,
 * because the faithfulness gate is not a proxy for a human judgement — it is the
 * judgement, and a disagreement there is a defect in one side rather than a
 * calibration figure.
 *
 * Nothing here writes a `reviewStatus`. The corpus stays `not_reviewed` even
 * with human scores merged, because a report about rows is not a property of the
 * rows; promoting the corpus needs a review log naming each row, its reviewer
 * and a time, on `verifyReviewedProvenance`'s terms, and that machinery is not
 * part of this pass.
 */
export function mergeHumanScores(
  report: CoachingScoreReport,
  humanScores: HumanScoreSet,
): CoachingScoreReport {
  const scores = humanScores === null || humanScores === undefined ? [] : humanScores.scores;
  if (!Array.isArray(scores) || scores.length === 0) {
    return { ...report, human: { status: 'not_collected', slot: humanScoringSlot() } };
  }

  const reviewers: string[] = [];
  const reviewedRows: string[] = [];
  const dimensionPass = {} as Record<RubricDimension, number>;
  const dimensionTotal = {} as Record<RubricDimension, number>;
  for (let index = 0; index < RUBRIC_DIMENSIONS.length; index += 1) {
    dimensionPass[RUBRIC_DIMENSIONS[index]] = 0;
    dimensionTotal[RUBRIC_DIMENSIONS[index]] = 0;
  }
  const agreementHits = {} as Record<ToneDimension, number>;
  const agreementTotal = {} as Record<ToneDimension, number>;
  for (let index = 0; index < TONE_DIMENSIONS.length; index += 1) {
    agreementHits[TONE_DIMENSIONS[index]] = 0;
    agreementTotal[TONE_DIMENSIONS[index]] = 0;
  }

  for (let index = 0; index < scores.length; index += 1) {
    const entry = scores[index];
    if (entry === null || entry === undefined) continue;
    if (!(RUBRIC_DIMENSIONS as readonly string[]).includes(entry.dimension)) continue;
    const recorded: RubricDimension = entry.dimension;
    if (!reviewers.includes(entry.reviewerId)) reviewers.push(entry.reviewerId);
    if (!reviewedRows.includes(entry.rowId)) reviewedRows.push(entry.rowId);
    dimensionTotal[recorded] += 1;
    if (entry.verdict === 'pass') dimensionPass[recorded] += 1;

    if (!(TONE_DIMENSIONS as readonly string[]).includes(entry.dimension)) continue;
    const dimension = entry.dimension as ToneDimension;
    const row = report.rows.find((candidate) => candidate.rowId === entry.rowId);
    if (row === undefined) continue;
    const tone = toneScoresOf(row.verdict);
    if (tone === null) continue;
    const automated = tone.find((candidate) => candidate.dimension === dimension);
    if (automated === undefined) continue;
    agreementTotal[dimension] += 1;
    if (automated.band === entry.verdict) agreementHits[dimension] += 1;
  }

  const byDimension = {} as Record<RubricDimension, CoachingMetric>;
  for (let index = 0; index < RUBRIC_DIMENSIONS.length; index += 1) {
    const dimension = RUBRIC_DIMENSIONS[index];
    byDimension[dimension] = metric(
      `human.${dimension}`,
      dimensionPass[dimension],
      dimensionTotal[dimension],
      'reviewer answers recorded for this dimension',
    );
  }
  const agreement = {} as Record<ToneDimension, CoachingMetric>;
  for (let index = 0; index < TONE_DIMENSIONS.length; index += 1) {
    const dimension = TONE_DIMENSIONS[index];
    agreement[dimension] = metric(
      `human.agreement.${dimension}`,
      agreementHits[dimension],
      agreementTotal[dimension],
      'reviewer answers on rows the automated tone gate also scored',
    );
  }

  return {
    ...report,
    human: {
      status: 'collected',
      collectedAt: humanScores.collectedAt,
      reviewerCount: reviewers.length,
      rowsReviewed: reviewedRows.length,
      byDimension: Object.freeze(byDimension),
      agreementWithAutomated: Object.freeze(agreement),
    },
  };
}
