/**
 * Shadow comparison: a candidate policy against the frozen one
 * (Sprint 05, issue #23).
 *
 * ## What this compares, and why it is not what the issue asked for
 *
 * #23 asks to "compare current ordering and Priority v1". Sprint 04 made those
 * the same code: `lib/utils/agendaScoring.ts` now delegates to
 * `lib/priority/priorityScorer.ts`, and a 260,000-case differential fuzz
 * confirmed the delegated path reproduces the original arithmetic exactly.
 * Implemented literally, this module would compare a thing to itself and report
 * zero disagreement forever — a dashboard that looks reassuring while measuring
 * nothing, which is a worse outcome than no dashboard, because a reader would
 * trust it.
 *
 * Reframed, per the Sprint 05 design: **same scorer, different weights**. The
 * frozen `DEFAULT_PRIORITY_POLICY` is the baseline, a candidate policy is the
 * thing under test, and the report says where the resulting order differs and
 * why. That is a real comparison, and it is the one #22's "no hard constraint
 * regresses" criterion actually needs.
 *
 * ## Features are extracted once, scored twice
 *
 * The feature vector is policy-independent, so each subject is extracted a
 * single time and that one vector is scored under both policies. This is not an
 * optimisation. It is what makes the report's central claim true: because the
 * inputs are provably identical between the two runs, every difference in the
 * output is attributable to the weights or to what the vector does not contain
 * — and to nothing else. Two extractions could differ, and then a third
 * explanation would exist that the report has no category for.
 *
 * For the same reason the band (`reason`) is supplied by the caller rather than
 * derived here. It comes from the agenda query, not from the weights; deriving
 * it inside the comparison would let a candidate policy appear to move an item
 * that had merely been re-classified. It also keeps this module out of
 * `agendaService`, which reaches `commandService` and therefore persistence.
 *
 * ## The cause split
 *
 * The substantive requirement. A rank change caused by an unknown feature is a
 * **data** problem — go and collect the missing input. A rank change caused by
 * different weights over identical known features is a **policy** problem — the
 * tuning did it. One number would send a reader to debug the wrong one.
 *
 * The rule, stated once and implemented exactly once below, for a commitment
 * whose rank moved:
 *
 *   Let `changedFeatures` be the features whose *weights differ* between the
 *   two policies (see `policyDelta`).
 *
 *   - **scoreMoved** — this commitment's own total differs between the two
 *     policies. Its known, re-weighted features are what moved it.
 *   - **blind** — this commitment has an unknown feature that is in
 *     `changedFeatures`: the tuning re-weighted a term that was never measured
 *     here, so the commitment sat still while its neighbours moved.
 *
 *   scoreMoved and blind  -> `mixed`
 *   blind alone           -> `missing_context`
 *   otherwise             -> `scorer_disagreement`
 *
 * The last branch also absorbs the collateral case: a commitment whose score
 * did not move and which is missing nothing relevant, but which changed rank
 * because others moved past it. Nothing about its data is absent, so the change
 * is entirely the tuning's.
 *
 * ### Why `dependency` and `effort` do not make everything missing context
 *
 * They are permanently unknown — `Commitment` has no such fields — and they are
 * reported in `unknownFeatures` on every row, because they genuinely are
 * unknown and the contract asks for the unknown features. But they never make a
 * row `missing_context`, because **no policy weights them**, so they are never
 * in `changedFeatures`.
 *
 * That is the line, and it is drawn deliberately: a *cause* must be something
 * that differs between the two runs. Both policies are exactly as blind to
 * dependency and effort as each other, so that blindness cannot explain a
 * difference between them. Counting it would mark every single disagreement
 * `missing_context` or `mixed`, `scorer_disagreement` would be unreachable, and
 * the split — the whole point of the report — would carry no information at
 * all. The standing gap is a real limitation of the feature set; it is not a
 * finding about this candidate policy.
 */
import {
  CALIBRATION_SCHEMA_VERSION,
  type DisagreementCause,
  type RankDisagreement,
  type ShadowComparisonReport,
  type ShadowSamplingConfig,
} from '../../../src/contracts/v1/calibrationContracts';
import type {
  PriorityFeatures,
  PriorityPolicy,
  PriorityReason,
  PriorityScore,
} from '../../../src/contracts/v1/priorityContracts';
import type { Commitment, Reminder } from '../../../src/domain/stateMachine';
import { compareStrings, parseIsoMs } from '../../lifeState/fields';
import { extractPriorityFeatures } from '../priorityFeatures';
import { rankPriorities, scorePriority } from '../priorityScorer';
import { policyDelta, type WeightedFeatureName } from './candidatePolicy';
import { selectSample, validateSamplingConfig } from './shadowSampling';

/**
 * Feature names in a fixed reporting order, so two runs serialize
 * `unknownFeatures` identically. `dependency` and `effort` are last because
 * they are on every row and would otherwise bury the actionable ones.
 */
const REPORTED_FEATURE_ORDER = Object.freeze([
  'urgency',
  'importance',
  'lateness',
  'userPressure',
  'dependency',
  'effort',
] as const);

type ReportedFeatureName = (typeof REPORTED_FEATURE_ORDER)[number];

const CAUSE_ORDER: readonly DisagreementCause[] = Object.freeze([
  'missing_context',
  'scorer_disagreement',
  'mixed',
]);

/**
 * One commitment as the comparison sees it.
 *
 * `reason` is required. See the note above: the band is context from the agenda
 * query, not an output of the policy, and both sides must see the same one or
 * the report cannot say what caused a move.
 */
export interface ShadowSubject {
  readonly commitment: Commitment;
  readonly reminders: readonly Reminder[];
  readonly reason: PriorityReason;
}

export interface ShadowComparisonInput {
  readonly subjects: readonly ShadowSubject[];
  readonly baselinePolicy: PriorityPolicy;
  readonly candidatePolicy: PriorityPolicy;
  readonly sampling: ShadowSamplingConfig;
  /** The instant features are measured against. Explicit; never the host clock. */
  readonly now: string;
  /**
   * Required, and never defaulted to the system clock.
   *
   * Sprint 04's review found that a report builder reading the clock itself
   * makes two runs over unchanged input produce different committed files, so
   * a diff stops meaning "something changed". The CLI owns the clock; this
   * function is a pure function of its arguments.
   */
  readonly generatedAt: string;
  readonly dueSoonWindowMs?: number;
}

function requireIso(label: string, value: string): string {
  if (typeof value !== 'string' || parseIsoMs(value) === null) {
    throw new TypeError(`shadow comparison: ${label} must be a valid ISO timestamp, received ${JSON.stringify(value)}`);
  }
  return value;
}

function unknownFeaturesOf(features: PriorityFeatures): readonly ReportedFeatureName[] {
  return REPORTED_FEATURE_ORDER.filter((name) => !features[name].known);
}

/** Rank by commitment id, 1-based, from the scorer's own total ordering. */
function ranksOf(scores: readonly PriorityScore[]): Map<string, number> {
  const ranked = rankPriorities({ scored: scores });
  const ranks = new Map<string, number>();
  ranked.forEach((score, index) => ranks.set(score.commitmentId, index + 1));
  return ranks;
}

/**
 * Kendall tau-a over the two rank vectors.
 *
 * tau-a rather than tau-b because neither ranking can contain a tie: the
 * scorer's comparator falls through to `commitmentId`, so both orderings are
 * total. A tie-corrected variant would be arithmetic guarding against a case
 * that cannot arise, and would read as if it could.
 *
 * Null below two items, because a correlation over one commitment is not a
 * weak measurement — there is no pair to be concordant or discordant about, and
 * emitting 1 would report perfect agreement where none was measured.
 */
function kendallTau(ids: readonly string[], left: Map<string, number>, right: Map<string, number>): number | null {
  if (ids.length < 2) return null;

  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const leftSign = Math.sign((left.get(ids[i]) as number) - (left.get(ids[j]) as number));
      const rightSign = Math.sign((right.get(ids[i]) as number) - (right.get(ids[j]) as number));
      if (leftSign === rightSign) concordant += 1;
      else discordant += 1;
    }
  }
  return (concordant - discordant) / ((ids.length * (ids.length - 1)) / 2);
}

function classifyCause(scoreMoved: boolean, blind: boolean): DisagreementCause {
  if (scoreMoved && blind) return 'mixed';
  if (blind) return 'missing_context';
  return 'scorer_disagreement';
}

export function buildShadowComparisonReport(input: ShadowComparisonInput): ShadowComparisonReport {
  const now = requireIso('now', input.now);
  const generatedAt = requireIso('generatedAt', input.generatedAt);
  const sampling = validateSamplingConfig(input.sampling);

  // Sorted before sampling so the report is a function of the corpus rather
  // than of the order it was assembled in. Ranking is already order-independent
  // (the scorer's comparator is total), but `disagreements` is emitted in this
  // order and would otherwise vary.
  const ordered = input.subjects
    .slice()
    .sort((left, right) => compareStrings(left.commitment.id, right.commitment.id));

  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].commitment.id === ordered[index - 1].commitment.id) {
      throw new TypeError(
        `shadow comparison: duplicate commitment id ${JSON.stringify(ordered[index].commitment.id)}; ranks are keyed by id`,
      );
    }
  }

  const sampled = selectSample(ordered, (subject) => subject.commitment.id, sampling);
  const delta = policyDelta(input.baselinePolicy, input.candidatePolicy);

  // One extraction per subject, scored twice. The identical input is what makes
  // the cause attribution below sound.
  const extracted = sampled.map((subject) => ({
    subject,
    features: extractPriorityFeatures({
      commitment: subject.commitment,
      reminders: subject.reminders,
      now,
      dueSoonWindowMs: input.dueSoonWindowMs,
    }),
  }));

  const baselineScores = extracted.map((entry) =>
    scorePriority({ features: entry.features, reason: entry.subject.reason, policy: input.baselinePolicy }),
  );
  const candidateScores = extracted.map((entry) =>
    scorePriority({ features: entry.features, reason: entry.subject.reason, policy: input.candidatePolicy }),
  );

  const baselineRanks = ranksOf(baselineScores);
  const candidateRanks = ranksOf(candidateScores);

  const disagreements: RankDisagreement[] = [];
  extracted.forEach((entry, index) => {
    const commitmentId = entry.subject.commitment.id;
    const baselineRank = baselineRanks.get(commitmentId) as number;
    const candidateRank = candidateRanks.get(commitmentId) as number;
    if (baselineRank === candidateRank) return;

    const unknownFeatures = unknownFeaturesOf(entry.features);
    const scoreMoved = baselineScores[index].total !== candidateScores[index].total;
    const blind = unknownFeatures.some((name) =>
      (delta.changedFeatures as readonly string[]).includes(name as WeightedFeatureName),
    );

    disagreements.push({
      commitmentId,
      baselineRank,
      candidateRank,
      cause: classifyCause(scoreMoved, blind),
      unknownFeatures: unknownFeatures.slice(),
    });
  });

  // Every cause key is present, including the zeros. A missing key would read
  // as "not measured" where the truth is "measured, and none".
  const byCause: Record<DisagreementCause, number> = {
    missing_context: 0,
    scorer_disagreement: 0,
    mixed: 0,
  };
  for (const disagreement of disagreements) byCause[disagreement.cause] += 1;

  const comparedIds = extracted.map((entry) => entry.subject.commitment.id);

  return {
    version: CALIBRATION_SCHEMA_VERSION,
    generatedAt,
    baselinePolicyVersion: input.baselinePolicy.version,
    candidatePolicyVersion: input.candidatePolicy.version,
    sampling,
    comparedCount: comparedIds.length,
    disagreements,
    byCause,
    rankCorrelation: kendallTau(comparedIds, baselineRanks, candidateRanks),
  };
}

/* ── Rendering ───────────────────────────────────────────────────── */

function formatCorrelation(value: number | null): string {
  return value === null ? 'not computable (fewer than two commitments compared)' : value.toFixed(4);
}

/**
 * The markdown rendering.
 *
 * The cause table is the body of the report rather than a footnote, and there
 * is no line anywhere that adds the three causes into a single "disagreements"
 * headline without the split beside it — collapsing them is the failure mode
 * this report exists to prevent.
 */
export function generateShadowComparisonMarkdown(report: ShadowComparisonReport): string {
  const lines: string[] = [];

  lines.push('# Priority Shadow Comparison');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Schema: ${report.version}`);
  lines.push('');
  lines.push(`Baseline policy: \`${report.baselinePolicyVersion}\``);
  lines.push(`Candidate policy: \`${report.candidatePolicyVersion}\``);
  lines.push(`Sampling: rate ${report.sampling.rate}, seed ${report.sampling.seed}`);
  lines.push(`Compared: ${report.comparedCount} commitments`);
  lines.push(`Kendall tau: ${formatCorrelation(report.rankCorrelation)}`);
  lines.push('');

  if (report.comparedCount === 0) {
    lines.push('**Nothing was compared.** The sample selected no commitments, so this report');
    lines.push('measures nothing — it does not report agreement.');
    lines.push('');
  }

  lines.push('## Disagreements by cause');
  lines.push('');
  lines.push('| Cause | Count | What it means | Where to look |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| \`missing_context\` | ${report.byCause.missing_context} | A re-weighted feature was never measured here, so the commitment stood still while others moved | **Data.** Collect the missing input |`,
  );
  lines.push(
    `| \`scorer_disagreement\` | ${report.byCause.scorer_disagreement} | Different weights over identical known features | **Policy.** The tuning did it |`,
  );
  lines.push(
    `| \`mixed\` | ${report.byCause.mixed} | Both: a re-weighted known feature moved the score *and* a re-weighted feature is unknown | **Both.** Collect the input before trusting the tuning |`,
  );
  lines.push('');

  if (report.disagreements.length === 0) {
    lines.push('No commitment changed rank between the two policies.');
    lines.push('');
  } else {
    lines.push('## Rank changes');
    lines.push('');
    lines.push('| Commitment | Baseline rank | Candidate rank | Cause | Unknown features |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of report.disagreements) {
      const unknown = row.unknownFeatures.length === 0 ? '—' : row.unknownFeatures.join(', ');
      lines.push(
        `| \`${row.commitmentId}\` | ${row.baselineRank} | ${row.candidateRank} | \`${row.cause}\` | ${unknown} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Reading this');
  lines.push('');
  lines.push('`dependency` and `effort` are unknown for every commitment — `Commitment` carries');
  lines.push('no such fields — so they appear in every "unknown features" cell. They never make a');
  lines.push('row `missing_context` on their own: no policy weights them, so both policies are');
  lines.push('equally blind to them, and a blindness both sides share cannot explain a difference');
  lines.push('between the two sides.');
  lines.push('');
  lines.push('This report changes nothing. The shipped policy is unaffected by any run of it.');

  return lines.join('\n');
}

export { CAUSE_ORDER };
