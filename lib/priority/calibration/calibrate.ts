/**
 * The calibration run: sweep, filter, compare, report (Sprint 05, issue #22).
 *
 * ── A report, never a config ───────────────────────────────────────
 *
 * Nothing in this module can change `DEFAULT_PRIORITY_POLICY`. `runCalibration`
 * takes the base policy as a value, never imports it, never writes anything,
 * and returns a `CalibrationReport` whose `policyUnchanged` is the literal
 * `true`. Shipping a candidate is a separate, deliberate act performed by a
 * human editing `priorityPolicy.ts` and the freeze test that pins it.
 *
 * That separation is structural rather than procedural on purpose. Weights
 * fitted to judgments nobody made look exactly like weights fitted to real
 * ones — same shape, same plausibility, same absence of any tell — so a rule
 * that depended on whoever ran the pipeline noticing which kind they had would
 * fail silently and look like success. `policyUnchanged` is a literal type for
 * the same reason: a boolean field could be set to `false` by a future caller
 * who thought they were being helpful.
 *
 * As a belt-and-braces check the run fingerprints the base policy before and
 * after the sweep and throws if it moved, so "the sweep did not mutate the
 * shipped policy" is a checked fact rather than a claim about `...spread`
 * discipline.
 *
 * ── The selection rule ─────────────────────────────────────────────
 *
 *  1. Evaluate the baseline and every candidate on the grid.
 *  2. **Filter** on hard constraints. Inadmissible candidates are kept in the
 *     report, so a reader can see what was rejected and why, but they can never
 *     be selected.
 *  3. Among admissible candidates, take the highest concordance rate that
 *     strictly beats the baseline; break ties by visit order, which the seed
 *     decides.
 *  4. If the baseline has no rate — nothing was scorable — there is nothing to
 *     improve on and `best` is null. A candidate cannot be declared better than
 *     a measurement that does not exist.
 *
 * Slice regressions are **reported, not filtered**. A candidate that lifts the
 * aggregate while dropping one slice may still be the right change; that is a
 * judgment for a person with the numbers in front of them, and the report's job
 * is to put them there. Hard constraints are different in kind, which is why
 * they are the only thing that rejects.
 *
 * Nothing here reads the clock: `generatedAt` arrives from the caller and the
 * CLI owns it.
 */
import type {
  CalibrationCandidate,
  CalibrationManifest,
  CalibrationReport,
  ConcordanceMetric,
  SliceMetrics,
} from '../../../src/contracts/v1/calibrationContracts';
import { CALIBRATION_SCHEMA_VERSION } from '../../../src/contracts/v1/calibrationContracts';
import type { JudgmentVerdict, PriorityPolicy } from '../../../src/contracts/v1/priorityContracts';
import { canonicalJson } from '../../evaluation/registry/fingerprint';
import { evaluateConcordance, type ConcordanceResult, type PredictedOrdering } from './concordance';
import { checkConstraints } from './constraints';
import { compareIds, computeCorpusDigest, type CalibrationCorpus } from './corpus';
import { assertUsableSeed, canonicalSweepGrid, enumerateSweepCandidates } from './sweep';

/* ── Shapes ─────────────────────────────────────────────────────── */

export type CalibrationStatus =
  /** No judgment rows at all. Reported, not rendered as a rate of zero. */
  | 'CORPUS EMPTY'
  /** Rows exist, but none of them produced a scorable pair. */
  | 'NO SCORABLE PAIRS'
  /** Nothing on the grid beat the baseline. */
  | 'NO IMPROVEMENT'
  /** Something beat the baseline, and every such candidate broke a constraint. */
  | 'NO ADMISSIBLE IMPROVEMENT'
  | 'IMPROVEMENT FOUND';

/** A pair the chosen candidate gets wrong that the baseline got right. */
export interface RegressedPair {
  readonly pairId: string;
  readonly slice: string;
  readonly targetVerdict: JudgmentVerdict;
  readonly baselinePredicted: PredictedOrdering | null;
  readonly candidatePredicted: PredictedOrdering | null;
}

/**
 * Extends the committed `CalibrationReport` rather than replacing it, the same
 * way `PriorityAgreementReport` extends `AgreementReport`: the contract fixes
 * what a consumer may rely on, and these add the audit detail that makes the
 * headline readable.
 */
export interface PriorityCalibrationReport extends CalibrationReport {
  /** Every candidate evaluated, in visit order. The sweep is auditable, not a black box. */
  readonly candidates: readonly CalibrationCandidate[];
  readonly admissibleCandidateCount: number;
  /** Candidates that beat the baseline and were rejected for a constraint. */
  readonly rejectedForConstraintCount: number;
  readonly regressedPairs: readonly RegressedPair[];
  readonly status: CalibrationStatus;
}

export interface CalibrationRunInput {
  readonly corpus: CalibrationCorpus;
  readonly basePolicy: PriorityPolicy;
  /** ISO instant supplied by the caller. Nothing under lib/priority reads a clock. */
  readonly generatedAt: string;
  readonly searchSeed: number;
  /** True only when this run consumed the locked split via the gate. */
  readonly lockedSplitUsed?: boolean;
}

export class CalibrationManifestMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationManifestMismatchError';
  }
}

/* ── Candidates ─────────────────────────────────────────────────── */

const EMPTY_METRIC: ConcordanceMetric = Object.freeze({
  concordantPairs: 0,
  scorablePairs: 0,
  unscorablePairs: 0,
  rate: null,
});

function sliceMetricsOf(baseline: ConcordanceResult, candidate: ConcordanceResult): readonly SliceMetrics[] {
  const slices = Array.from(new Set([...Object.keys(baseline.bySlice), ...Object.keys(candidate.bySlice)])).sort(
    compareIds,
  );
  return slices.map((slice) => ({
    slice,
    before: baseline.bySlice[slice] ?? EMPTY_METRIC,
    after: candidate.bySlice[slice] ?? EMPTY_METRIC,
  }));
}

function buildCandidate(
  policy: PriorityPolicy,
  corpus: CalibrationCorpus,
  baseline: ConcordanceResult,
  candidate: ConcordanceResult,
): CalibrationCandidate {
  const constraintViolations = checkConstraints(corpus, policy).violations;
  return {
    policy,
    overall: candidate.overall,
    bySlice: sliceMetricsOf(baseline, candidate),
    constraintViolations,
    // The filter, stated as data. `admissible` is never anything but this.
    admissible: constraintViolations.length === 0,
  };
}

function regressedPairsBetween(baseline: ConcordanceResult, candidate: ConcordanceResult): readonly RegressedPair[] {
  const candidateByPairId = new Map(candidate.outcomes.map((outcome) => [outcome.pairId, outcome]));
  const regressed: RegressedPair[] = [];

  for (const before of baseline.outcomes) {
    if (before.status !== 'concordant' || before.targetVerdict === null) continue;
    const after = candidateByPairId.get(before.pairId);
    if (after === undefined || after.status !== 'discordant') continue;
    regressed.push({
      pairId: before.pairId,
      slice: before.slice,
      targetVerdict: before.targetVerdict,
      baselinePredicted: before.predicted,
      candidatePredicted: after.predicted,
    });
  }

  return regressed.sort((left, right) => compareIds(left.pairId, right.pairId));
}

/* ── The run ────────────────────────────────────────────────────── */

export function runCalibration(input: CalibrationRunInput): PriorityCalibrationReport {
  const { corpus, basePolicy, generatedAt, searchSeed } = input;
  assertUsableSeed(searchSeed);
  if (typeof generatedAt !== 'string' || generatedAt.length === 0) {
    throw new TypeError('calibration: generatedAt must be supplied by the caller; lib/priority owns no clock');
  }

  const basePolicyFingerprint = canonicalJson(basePolicy);

  const baselineConcordance = evaluateConcordance(corpus, basePolicy);
  const baseline = buildCandidate(basePolicy, corpus, baselineConcordance, baselineConcordance);

  const candidates: CalibrationCandidate[] = [];
  const concordanceByVersion = new Map<string, ConcordanceResult>();
  for (const policy of enumerateSweepCandidates(basePolicy, searchSeed)) {
    const concordance = evaluateConcordance(corpus, policy);
    concordanceByVersion.set(policy.version, concordance);
    candidates.push(buildCandidate(policy, corpus, baselineConcordance, concordance));
  }

  const baselineRate = baseline.overall.rate;
  const improving = candidates.filter(
    (candidate) => baselineRate !== null && candidate.overall.rate !== null && candidate.overall.rate > baselineRate,
  );

  // First past the post in visit order, which is what makes the seed matter.
  let best: CalibrationCandidate | null = null;
  for (const candidate of improving) {
    if (!candidate.admissible) continue;
    if (best === null || candidate.overall.rate! > best.overall.rate!) best = candidate;
  }

  const bestConcordance = best === null ? null : concordanceByVersion.get(best.policy.version)!;
  const regressions =
    best === null ? [] : best.bySlice.filter((slice) => slice.after.rate !== null && slice.before.rate !== null && slice.after.rate < slice.before.rate);
  const regressedPairs = bestConcordance === null ? [] : regressedPairsBetween(baselineConcordance, bestConcordance);

  const status: CalibrationStatus =
    corpus.judgments.length === 0
      ? 'CORPUS EMPTY'
      : baselineRate === null
        ? 'NO SCORABLE PAIRS'
        : best !== null
          ? 'IMPROVEMENT FOUND'
          : improving.length > 0
            ? 'NO ADMISSIBLE IMPROVEMENT'
            : 'NO IMPROVEMENT';

  const manifest: CalibrationManifest = {
    version: CALIBRATION_SCHEMA_VERSION,
    generatedAt,
    corpusDigest: computeCorpusDigest(corpus),
    corpusProvenance: corpus.provenance,
    basePolicyVersion: basePolicy.version,
    searchSeed,
    // Baseline included: it is a policy that was evaluated, and a replay that
    // rebuilt only the grid would be rebuilding a different run.
    candidatesEvaluated: candidates.length + 1,
    lockedSplitUsed: input.lockedSplitUsed ?? false,
  };

  if (canonicalJson(basePolicy) !== basePolicyFingerprint) {
    throw new Error('calibration: the base policy was mutated during the sweep; a calibration run is read-only');
  }

  return {
    version: CALIBRATION_SCHEMA_VERSION,
    manifest,
    baseline,
    best,
    regressions,
    // The literal, and the point of the sprint. See the header.
    policyUnchanged: true,
    candidates,
    admissibleCandidateCount: candidates.filter((candidate) => candidate.admissible).length,
    rejectedForConstraintCount: improving.filter((candidate) => !candidate.admissible).length,
    regressedPairs,
    status,
  };
}

/**
 * Replays a run from its manifest.
 *
 * Everything the run varies on comes out of the manifest; the corpus and base
 * policy are supplied because a digest is not a corpus. Each field is verified
 * rather than trusted, and a mismatch throws instead of running: a replay that
 * quietly ran against different inputs and produced a different answer would
 * look exactly like a reproducibility failure in the code.
 */
export function runCalibrationFromManifest(
  manifest: CalibrationManifest,
  deps: { corpus: CalibrationCorpus; basePolicy: PriorityPolicy },
): PriorityCalibrationReport {
  if (manifest === null || typeof manifest !== 'object') {
    throw new CalibrationManifestMismatchError('calibration replay: manifest must be an object');
  }
  if (manifest.version !== CALIBRATION_SCHEMA_VERSION) {
    throw new CalibrationManifestMismatchError(
      `calibration replay: manifest version '${String(manifest.version)}' is not '${CALIBRATION_SCHEMA_VERSION}'`,
    );
  }
  if (typeof manifest.searchSeed !== 'number' || !Number.isInteger(manifest.searchSeed)) {
    throw new CalibrationManifestMismatchError(
      'calibration replay: manifest carries no integer searchSeed, so the candidate order cannot be rebuilt',
    );
  }
  if (typeof manifest.generatedAt !== 'string' || manifest.generatedAt.length === 0) {
    throw new CalibrationManifestMismatchError('calibration replay: manifest carries no generatedAt');
  }
  if (deps.basePolicy.version !== manifest.basePolicyVersion) {
    throw new CalibrationManifestMismatchError(
      `calibration replay: base policy is '${deps.basePolicy.version}', manifest names '${manifest.basePolicyVersion}'`,
    );
  }
  if (deps.corpus.provenance !== manifest.corpusProvenance) {
    throw new CalibrationManifestMismatchError(
      `calibration replay: corpus provenance is '${deps.corpus.provenance}', manifest names '${manifest.corpusProvenance}'`,
    );
  }
  const digest = computeCorpusDigest(deps.corpus);
  if (digest !== manifest.corpusDigest) {
    throw new CalibrationManifestMismatchError(
      `calibration replay: corpus digest ${digest} does not match the manifest's ${manifest.corpusDigest}`,
    );
  }

  const report = runCalibration({
    corpus: deps.corpus,
    basePolicy: deps.basePolicy,
    generatedAt: manifest.generatedAt,
    searchSeed: manifest.searchSeed,
    lockedSplitUsed: manifest.lockedSplitUsed,
  });

  // The grid lives in code, not in the manifest. This is what notices when the
  // code moved underneath a stored manifest.
  if (report.manifest.candidatesEvaluated !== manifest.candidatesEvaluated) {
    throw new CalibrationManifestMismatchError(
      `calibration replay: the sweep now evaluates ${report.manifest.candidatesEvaluated} candidates, ` +
        `the manifest recorded ${manifest.candidatesEvaluated}; the search grid has changed since that run`,
    );
  }

  return report;
}

/** Canonical bytes. Key order and whitespace cannot vary between two runs. */
export function serializeCalibrationReport(report: PriorityCalibrationReport): string {
  return canonicalJson(report);
}

/** The grid size, for callers that want to state the search budget up front. */
export function sweepBudget(basePolicy: PriorityPolicy): number {
  return canonicalSweepGrid(basePolicy).length + 1;
}
