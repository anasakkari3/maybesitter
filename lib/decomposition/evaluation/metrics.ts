/**
 * Boundary, coverage and semantic-faithfulness metrics (Sprint 06, issue #26).
 *
 * ── Every score carries its denominator ─────────────────────────────
 *
 * `MetricScore` has no field for a bare number. A faithfulness of 1.0 over 3 of
 * 40 examples and a faithfulness of 1.0 over 40 are different claims that
 * become the same claim the moment the value is copied anywhere without the
 * count, and the smaller one is the one that flatters. This repository already
 * enforces the convention for its other coverage figures
 * (`lib/priority/rubric/seedSetCoverage.ts`, `lib/priority/annotation/queueCoverage.ts`);
 * this module carries it into ratios by making the denominator, and a sentence
 * naming what the denominator counts, part of the value's own type.
 *
 * A ratio over zero is `null`, never `0`. Zero is a measurement — "nothing was
 * faithful" — and an empty denominator is the absence of one. Rendering the
 * second as the first presents no data as a bad result, which Sprint 04's
 * agreement report already refused to do.
 *
 * ── Three metrics, three different scopes, each stated ──────────────
 *
 * They deliberately do not share a denominator, because they are not answering
 * the same question:
 *
 *  - **Boundary** is over *spans*: did the cuts land where the ground truth
 *    says they land. Recall's denominator is expected spans, precision's is
 *    produced spans, and a row with neither contributes to neither.
 *  - **Coverage** is over *code units of source text*, and only over rows the
 *    decomposer actually decomposed. A refusal has no steps, so it has no
 *    coverage — including it at zero would understate a decomposer that is
 *    correctly conservative.
 *  - **Faithfulness** is over *examples*: did it invent anything, cite anything
 *    it could not, or split what must not be split.
 *
 * ── Under-splitting is not an invention ─────────────────────────────
 *
 * A proposal that produces no steps is scored as a boundary miss and left out
 * of faithfulness entirely. Charging it to faithfulness would make "declined to
 * answer" and "fabricated a date" the same finding, and a decomposer that
 * refuses everything would score exactly as dishonestly as one that makes
 * things up — while being, in fact, the safe failure.
 *
 * ── Boundary matches on offsets; the carried text is faithfulness ───
 *
 * Two spans match when their `[start, end)` ranges are equal. Whether a span's
 * `text` is really what those offsets select is `SPAN_MISMATCH`, counted under
 * faithfulness. Folding the check into boundary would report a forged span as a
 * misplaced cut, which is the wrong repair to go looking for.
 *
 * No function here reads the system clock.
 */
import type {
  DecompositionExample,
  DecompositionProposal,
  DecompositionStepProposal,
  DecompositionViolation,
  DecompositionViolationCode,
  SourceSpan,
} from '../../../src/contracts/v1/decompositionContracts';
import { isIsoTimestamp } from '../../evaluation/registry/validationPrimitives';
import { validateProposedSteps } from './example';

function fail(message: string): never {
  throw new Error(`decomposition metrics: ${message}`);
}

/** Code-unit ordering, never localeCompare: these reports are committed artifacts. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ── Scores ─────────────────────────────────────────────────────── */

export interface MetricScore {
  readonly metric: string;
  /** `numerator / denominator`, or null when the denominator is zero. */
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  /** What the denominator counts, in words. A number without this is not a claim. */
  readonly denominatorOf: string;
}

function score(metric: string, numerator: number, denominator: number, denominatorOf: string): MetricScore {
  return Object.freeze({
    metric,
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
    denominatorOf,
  });
}

/* ── Pairing examples with proposals ────────────────────────────── */

export interface EvaluationCase {
  readonly example: DecompositionExample;
  readonly proposal: DecompositionProposal;
}

export interface PairedProposals {
  readonly cases: readonly EvaluationCase[];
  /** Examples no proposal answered. Named, so a shrunken denominator is visible. */
  readonly unevaluatedExampleIds: readonly string[];
  /** Proposals answering no example. Reported rather than scored against nothing. */
  readonly unmatchedProposalIds: readonly string[];
}

export interface PairProposalsOptions {
  /**
   * How a proposal names the example it answers. Defaults to `commitmentId`,
   * which is the harness convention: an evaluation run creates one synthetic
   * commitment per example and gives it the example's id. A caller whose
   * commitments have real ids passes its own mapping rather than renaming its
   * commitments to suit the evaluator.
   */
  readonly keyOf?: (proposal: DecompositionProposal) => string;
}

export function pairProposals(
  examples: readonly DecompositionExample[],
  proposals: readonly DecompositionProposal[],
  options: PairProposalsOptions = {},
): PairedProposals {
  const keyOf = options.keyOf ?? ((proposal: DecompositionProposal) => proposal.commitmentId);
  const byExampleId = new Map<string, DecompositionProposal>();
  const unmatched: string[] = [];

  for (const proposal of proposals) {
    const key = keyOf(proposal);
    if (byExampleId.has(key)) {
      fail(`two proposals answer example '${key}'; the evaluator cannot pick one on the caller's behalf`);
    }
    byExampleId.set(key, proposal);
  }

  const cases: EvaluationCase[] = [];
  const unevaluated: string[] = [];
  const exampleIds = new Set(examples.map((example) => example.exampleId));

  for (const example of examples) {
    const proposal = byExampleId.get(example.exampleId);
    if (proposal === undefined) unevaluated.push(example.exampleId);
    else cases.push(Object.freeze({ example, proposal }));
  }
  for (const proposal of proposals) {
    if (!exampleIds.has(keyOf(proposal))) unmatched.push(proposal.proposalId);
  }

  return Object.freeze({
    cases: Object.freeze(cases),
    unevaluatedExampleIds: Object.freeze(unevaluated.slice().sort(byCodeUnit)),
    unmatchedProposalIds: Object.freeze(unmatched.slice().sort(byCodeUnit)),
  });
}

/** The steps a proposal offers. An atomic or rejected proposal offers none. */
function producedSteps(proposal: DecompositionProposal): readonly DecompositionStepProposal[] {
  return proposal.outcome === 'decomposed' ? proposal.steps : [];
}

/* ── Boundary ───────────────────────────────────────────────────── */

/** Offsets only. See the module note on why `text` is faithfulness, not boundary. */
function spanKey(span: SourceSpan): string {
  return `${span.start}:${span.end}`;
}

function spanMultiset(steps: readonly DecompositionStepProposal[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of steps) {
    for (const span of step.sourceSpans) {
      const key = spanKey(span);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Multiset intersection size.
 *
 * A multiset rather than a set: a decomposer that emits the same span three
 * times has produced one correct boundary and two duplicates, and set semantics
 * would silently forgive the duplicates by collapsing them.
 */
function intersectionSize(left: Map<string, number>, right: Map<string, number>): number {
  let total = 0;
  left.forEach((count, key) => {
    total += Math.min(count, right.get(key) ?? 0);
  });
  return total;
}

function multisetSize(counts: Map<string, number>): number {
  let total = 0;
  counts.forEach((count) => {
    total += count;
  });
  return total;
}

function multisetsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  let equal = true;
  left.forEach((count, key) => {
    if (right.get(key) !== count) equal = false;
  });
  return equal;
}

export interface BoundaryMetrics {
  /** Expected spans the decomposer found. */
  readonly spanRecall: MetricScore;
  /** Produced spans the ground truth agrees with. */
  readonly spanPrecision: MetricScore;
  /** Rows where the produced span set is exactly the expected one, refusals included. */
  readonly exactExampleAgreement: MetricScore;
  /** Rows that have any expected span at all, so a recall of null is readable. */
  readonly examplesWithExpectedSpans: number;
}

function buildBoundaryMetrics(cases: readonly EvaluationCase[]): BoundaryMetrics {
  let matched = 0;
  let expectedTotal = 0;
  let producedTotal = 0;
  let exact = 0;
  let withExpectedSpans = 0;

  for (const evaluated of cases) {
    const expected = spanMultiset(evaluated.example.expectedSteps);
    const produced = spanMultiset(producedSteps(evaluated.proposal));
    const expectedSize = multisetSize(expected);

    matched += intersectionSize(expected, produced);
    expectedTotal += expectedSize;
    producedTotal += multisetSize(produced);
    if (expectedSize > 0) withExpectedSpans += 1;
    // A refusal on a do-not-split row has two empty multisets and counts as
    // agreement. That is the point: not cutting is the correct boundary there.
    if (multisetsEqual(expected, produced)) exact += 1;
  }

  return Object.freeze({
    spanRecall: score('boundary.spanRecall', matched, expectedTotal, 'expected source spans in the evaluated examples'),
    spanPrecision: score(
      'boundary.spanPrecision',
      matched,
      producedTotal,
      'source spans the proposals produced for the evaluated examples',
    ),
    exactExampleAgreement: score(
      'boundary.exactExampleAgreement',
      exact,
      cases.length,
      'evaluated examples',
    ),
    examplesWithExpectedSpans: withExpectedSpans,
  });
}

/* ── Coverage ───────────────────────────────────────────────────── */

/**
 * Total code units covered by a set of spans, counting overlaps once.
 *
 * A union rather than a sum: summing lengths would let a decomposer reach 100%
 * coverage by emitting the same step twice, which is the opposite of accounting
 * for the source text.
 */
export function coveredCodeUnits(steps: readonly DecompositionStepProposal[]): number {
  const ranges = steps
    .reduce<SourceSpan[]>((all, step) => all.concat(step.sourceSpans), [])
    .slice()
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));

  let total = 0;
  let openStart = -1;
  let openEnd = -1;
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    if (openEnd < range.start) {
      if (openStart >= 0) total += openEnd - openStart;
      openStart = range.start;
      openEnd = range.end;
    } else if (range.end > openEnd) {
      openEnd = range.end;
    }
  }
  if (openStart >= 0) total += openEnd - openStart;
  return total;
}

export interface CoverageRow {
  readonly exampleId: string;
  readonly coveredCodeUnits: number;
  readonly sourceCodeUnits: number;
  readonly ratio: number;
}

export interface CoverageMetrics {
  /** Source text the produced steps account for. */
  readonly produced: MetricScore;
  /** The same figure for the ground truth: the ceiling `produced` is read against. */
  readonly expected: MetricScore;
  /** Rows the decomposer actually decomposed. A refusal has no coverage to report. */
  readonly examplesInScope: number;
  readonly evaluatedExamples: number;
  readonly perExample: readonly CoverageRow[];
}

function buildCoverageMetrics(cases: readonly EvaluationCase[]): CoverageMetrics {
  const inScope = cases.filter((evaluated) => evaluated.proposal.outcome === 'decomposed');

  let covered = 0;
  let sourceUnits = 0;
  let expectedCovered = 0;
  const perExample: CoverageRow[] = [];

  for (const evaluated of inScope) {
    const units = evaluated.proposal.sourceText.length;
    const own = coveredCodeUnits(producedSteps(evaluated.proposal));
    covered += own;
    sourceUnits += units;
    expectedCovered += coveredCodeUnits(evaluated.example.expectedSteps);
    perExample.push(
      Object.freeze({
        exampleId: evaluated.example.exampleId,
        coveredCodeUnits: own,
        sourceCodeUnits: units,
        ratio: units === 0 ? 0 : own / units,
      }),
    );
  }

  const denominatorOf = `source code units across the ${inScope.length} decomposed proposal(s)`;
  return Object.freeze({
    produced: score('coverage.produced', covered, sourceUnits, denominatorOf),
    expected: score('coverage.expected', expectedCovered, sourceUnits, denominatorOf),
    examplesInScope: inScope.length,
    evaluatedExamples: cases.length,
    perExample: Object.freeze(perExample.slice().sort((a, b) => byCodeUnit(a.exampleId, b.exampleId))),
  });
}

/* ── Semantic faithfulness ──────────────────────────────────────── */

/**
 * The subset of the shared vocabulary that is a claim about the world rather
 * than about structure.
 *
 * In: `SPAN_MISMATCH` (this text is not where I said it was), `INVENTED_TIMING`
 * and `INVENTED_OWNER` (a fact nobody stated), `UNSOURCED_STEP` and
 * `INFERRED_WITH_SPAN` (a provenance claim that does not hold), `SPLIT_ATOMIC`
 * (a step the user never described).
 *
 * Out: `EMPTY_STEP`, `CONJUNCTION_ONLY`, `DUPLICATE_STEP_ID`, `SPAN_OVERLAP`,
 * `SPAN_OUT_OF_RANGE` and the three dependency codes. Each is a malformed
 * proposal rather than a dishonest one — #27 rejects them outright, so they
 * never reach a user to mislead anyone, and counting them here would make a
 * decomposer that emits garbage look like one that lies.
 */
export const FAITHFULNESS_VIOLATION_CODES: readonly DecompositionViolationCode[] = Object.freeze([
  'SPAN_MISMATCH',
  'INVENTED_TIMING',
  'INVENTED_OWNER',
  'UNSOURCED_STEP',
  'INFERRED_WITH_SPAN',
  'SPLIT_ATOMIC',
]);

export type FaithfulnessViolationCounts = Readonly<Record<string, number>>;

export interface FaithfulnessMetrics {
  /** Evaluated examples whose proposal carries no faithfulness violation. */
  readonly clean: MetricScore;
  /** Do-not-split and atomic rows the decomposer declined to split. */
  readonly doNotSplitRespected: MetricScore;
  /** Every code in the vocabulary, including the ones at zero. */
  readonly violationCounts: FaithfulnessViolationCounts;
  readonly offendingExampleIds: readonly string[];
}

/**
 * Faithfulness violations for one produced proposal.
 *
 * The ground-truth label is passed to the validator so `SPLIT_ATOMIC` means
 * "split something the corpus says is one task". A proposal with no steps is
 * skipped entirely: with zero steps and a `multi_step` label the validator would
 * report `SPLIT_ATOMIC` for the *opposite* defect — under-splitting — and that
 * belongs to boundary recall, not here.
 */
export function faithfulnessViolationsFor(evaluated: EvaluationCase): readonly DecompositionViolation[] {
  const steps = producedSteps(evaluated.proposal);
  if (steps.length === 0) return Object.freeze([]);
  return validateProposedSteps(evaluated.proposal.sourceText, steps, evaluated.example.label).filter(
    (violation) => FAITHFULNESS_VIOLATION_CODES.indexOf(violation.code) >= 0,
  );
}

function buildFaithfulnessMetrics(cases: readonly EvaluationCase[]): FaithfulnessMetrics {
  // Every code gets a key, at zero if it never fired. An absent key and a zero
  // read identically in a diff only to a reader who already knows the whole
  // vocabulary, and a report exists for the reader who does not.
  const counts: Record<string, number> = {};
  for (const code of FAITHFULNESS_VIOLATION_CODES) counts[code] = 0;

  let clean = 0;
  const offending: string[] = [];
  let unsplittable = 0;
  let unsplittableRespected = 0;

  for (const evaluated of cases) {
    const violations = faithfulnessViolationsFor(evaluated);
    for (const violation of violations) counts[violation.code] += 1;
    if (violations.length === 0) clean += 1;
    else offending.push(evaluated.example.exampleId);

    const label = evaluated.example.label;
    if (label === 'do_not_split' || label === 'atomic') {
      unsplittable += 1;
      if (evaluated.proposal.outcome !== 'decomposed') unsplittableRespected += 1;
    }
  }

  return Object.freeze({
    clean: score('faithfulness.clean', clean, cases.length, 'evaluated examples'),
    doNotSplitRespected: score(
      'faithfulness.doNotSplitRespected',
      unsplittableRespected,
      unsplittable,
      'evaluated examples labelled do_not_split or atomic',
    ),
    violationCounts: Object.freeze(counts),
    offendingExampleIds: Object.freeze(offending.slice().sort(byCodeUnit)),
  });
}

/* ── Report ─────────────────────────────────────────────────────── */

export interface DecompositionEvaluationReport {
  readonly generatedAt: string;
  /** Examples supplied, including the ones nothing answered. */
  readonly totalExamples: number;
  /** Examples a proposal answered. Every score below is over this, not over `totalExamples`. */
  readonly evaluatedExamples: number;
  readonly unevaluatedExampleIds: readonly string[];
  readonly unmatchedProposalIds: readonly string[];
  readonly boundary: BoundaryMetrics;
  readonly coverage: CoverageMetrics;
  readonly faithfulness: FaithfulnessMetrics;
  /** Reported, never inferred from a page of zeros. */
  readonly corpusEmpty: boolean;
  readonly status: 'CORPUS EMPTY' | 'REPORTED';
}

export interface BuildEvaluationReportOptions extends PairProposalsOptions {
  readonly examples: readonly DecompositionExample[];
  readonly proposals: readonly DecompositionProposal[];
  /** Required. These reports are committed artifacts; the caller owns the clock. */
  readonly generatedAt: string;
}

export function buildEvaluationReport(
  options: BuildEvaluationReportOptions,
): DecompositionEvaluationReport {
  if (!isIsoTimestamp(options?.generatedAt)) {
    fail('generatedAt must be an ISO-8601 timestamp; this builder reads no clock of its own');
  }
  const paired = pairProposals(options.examples, options.proposals, { keyOf: options.keyOf });

  return Object.freeze({
    generatedAt: options.generatedAt,
    totalExamples: options.examples.length,
    evaluatedExamples: paired.cases.length,
    unevaluatedExampleIds: paired.unevaluatedExampleIds,
    unmatchedProposalIds: paired.unmatchedProposalIds,
    boundary: buildBoundaryMetrics(paired.cases),
    coverage: buildCoverageMetrics(paired.cases),
    faithfulness: buildFaithfulnessMetrics(paired.cases),
    corpusEmpty: paired.cases.length === 0,
    status: paired.cases.length === 0 ? 'CORPUS EMPTY' : 'REPORTED',
  });
}
