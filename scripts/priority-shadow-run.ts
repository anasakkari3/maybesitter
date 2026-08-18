/**
 * Priority shadow comparison CLI (Sprint 05, issue #23).
 *
 * Ranks the annotation seed set under the frozen policy and under a candidate
 * policy, and writes the disagreement report as markdown plus JSON under
 * docs/quality/reports/.
 *
 * ## What this does not do
 *
 * It does not change the shipped policy, and it cannot: it constructs a
 * candidate object in memory, ranks with it, and prints what would have moved.
 * `DEFAULT_PRIORITY_POLICY` is frozen this sprint and nothing in
 * lib/priority/shadow can write anywhere — see
 * tests/priority/shadowBoundaries.test.ts, which walks the transitive import
 * closure.
 *
 * ## The clock lives here
 *
 * `buildShadowComparisonReport` takes `generatedAt` as a required argument.
 * Sprint 04's review found that a report builder reading the system clock makes
 * two runs over unchanged input produce different committed files, so a diff
 * stops meaning "something changed". The one `new Date()` in this track is the
 * line below.
 *
 * ## The corpus
 *
 * `tests/fixtures/prioritySeedSet.ts` — the same twenty pairs (forty
 * commitments) the annotation rubric uses, at the fixed seed clock. Synthetic,
 * engineering QA only, and labelled as such at its source. It is used here
 * because a shadow comparison needs commitments and the product ships none:
 * lib/priority/rubric already reads the same corpus for the same reason.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-shadow-run.ts
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-shadow-run.ts \
 *     --weight importanceHigh=400 --weight userPressureRecent=500 --rate 0.5 --seed 11
 *
 * Options:
 *   --weight <key>=<number>   Override one policy weight on the candidate. Repeatable.
 *   --band-cap <number>       Override the candidate band cap.
 *   --total-cap <number>      Override the candidate total cap.
 *   --candidate-version <id>  Name the candidate. Defaults to a demo label.
 *   --rate <0..1>             Sampling rate. Default 1.
 *   --seed <integer>          Sampling seed. Default 0.
 *   --json-only               Skip the markdown rendering.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_PRIORITY_POLICY } from '../lib/priority/priorityPolicy';
import { derivePolicy, policyDelta, WEIGHT_FEATURES, type PolicyWeightKey } from '../lib/priority/shadow/candidatePolicy';
import {
  buildShadowComparisonReport,
  generateShadowComparisonMarkdown,
  type ShadowSubject,
} from '../lib/priority/shadow/shadowComparison';
import {
  PRIORITY_SEED_PAIRS,
  SEED_CLOCK_ISO,
  SEED_DUE_SOON_WINDOW_MS,
} from '../tests/fixtures/prioritySeedSet';

/**
 * The default candidate, when the caller names no override.
 *
 * Labelled `demo` because that is what it is: a perturbation chosen to exercise
 * the mechanism, not a proposed tuning. Sprint 05 fits no weights to real
 * judgments because no real judgments exist, and a default that looked like a
 * recommendation would be exactly the confusion the empty corpus exists to
 * prevent.
 */
const DEMO_WEIGHTS: Partial<Record<PolicyWeightKey, number>> = {
  importanceHigh: 400,
  userPressureRecent: 500,
};

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

function flagValues(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((argument, index) => {
    if (argument === `--${name}` && index + 1 < process.argv.length) values.push(process.argv[index + 1]);
  });
  return values;
}

function numberFlag(name: string, fallback: number): number {
  const raw = flagValue(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new TypeError(`--${name} must be a number, received ${JSON.stringify(raw)}`);
  return parsed;
}

/** `--weight importanceHigh=400`, validated against the contract's own key set. */
function parseWeightOverrides(): Partial<Record<PolicyWeightKey, number>> {
  const overrides: Partial<Record<PolicyWeightKey, number>> = {};
  for (const entry of flagValues('weight')) {
    const separator = entry.indexOf('=');
    if (separator === -1) throw new TypeError(`--weight expects <key>=<number>, received ${JSON.stringify(entry)}`);

    const key = entry.slice(0, separator) as PolicyWeightKey;
    const value = Number(entry.slice(separator + 1));
    if (!Object.prototype.hasOwnProperty.call(WEIGHT_FEATURES, key)) {
      throw new TypeError(`--weight: unknown policy weight ${JSON.stringify(key)}`);
    }
    if (!Number.isFinite(value)) throw new TypeError(`--weight ${key}: value must be a number`);
    overrides[key] = value;
  }
  return overrides;
}

function seedSubjects(): readonly ShadowSubject[] {
  return PRIORITY_SEED_PAIRS.flatMap((pair) =>
    [pair.left, pair.right].map((side) => ({
      commitment: side.commitment,
      reminders: side.reminders,
      reason: side.reason,
    })),
  );
}

async function main(): Promise<void> {
  const jsonOnly = process.argv.includes('--json-only');
  const explicitWeights = parseWeightOverrides();
  const usingDemo = Object.keys(explicitWeights).length === 0 && flagValue('band-cap') === null && flagValue('total-cap') === null;

  const bandCap = flagValue('band-cap') === null ? undefined : numberFlag('band-cap', DEFAULT_PRIORITY_POLICY.bandCap);
  const totalCap = flagValue('total-cap') === null ? undefined : numberFlag('total-cap', DEFAULT_PRIORITY_POLICY.totalCap);

  const candidatePolicy = derivePolicy(DEFAULT_PRIORITY_POLICY, {
    version: flagValue('candidate-version') ?? (usingDemo ? 'priority-policy-candidate-demo' : 'priority-policy-candidate'),
    weights: usingDemo ? DEMO_WEIGHTS : explicitWeights,
    bandCap,
    totalCap,
  });

  const delta = policyDelta(DEFAULT_PRIORITY_POLICY, candidatePolicy);
  const subjects = seedSubjects();

  // The CLI owns the clock; the report builder takes it.
  const generatedAt = new Date().toISOString();
  const report = buildShadowComparisonReport({
    subjects,
    baselinePolicy: DEFAULT_PRIORITY_POLICY,
    candidatePolicy,
    sampling: { rate: numberFlag('rate', 1), seed: numberFlag('seed', 0) },
    now: SEED_CLOCK_ISO,
    dueSoonWindowMs: SEED_DUE_SOON_WINDOW_MS,
    generatedAt,
  });

  const reportDir = join(process.cwd(), 'docs', 'quality', 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportJson = join(reportDir, 'priority-shadow-comparison.json');
  const reportMd = join(reportDir, 'priority-shadow-comparison.md');

  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  if (!jsonOnly) writeFileSync(reportMd, `${generateShadowComparisonMarkdown(report)}\n`);

  console.log('=== Priority Shadow Comparison ===');
  console.log(`Corpus: ${subjects.length} seed commitments at ${SEED_CLOCK_ISO} (SYNTHETIC — engineering QA only)`);
  console.log(`Baseline: ${report.baselinePolicyVersion}`);
  console.log(`Candidate: ${report.candidatePolicyVersion}${usingDemo ? ' (demo perturbation, not a proposed tuning)' : ''}`);
  console.log(`Changed weights: ${delta.changedWeightKeys.length === 0 ? 'none' : delta.changedWeightKeys.join(', ')}`);
  console.log(`Changed structure: ${delta.changedStructuralKeys.length === 0 ? 'none' : delta.changedStructuralKeys.join(', ')}`);
  console.log(`Re-weighted features: ${delta.changedFeatures.length === 0 ? 'none' : delta.changedFeatures.join(', ')}`);
  console.log(`Sampling: rate ${report.sampling.rate}, seed ${report.sampling.seed}`);
  console.log(`Compared: ${report.comparedCount} | Rank changes: ${report.disagreements.length}`);
  console.log(
    `  missing_context=${report.byCause.missing_context} (data) | ` +
      `scorer_disagreement=${report.byCause.scorer_disagreement} (policy) | ` +
      `mixed=${report.byCause.mixed}`,
  );
  console.log(
    `Kendall tau: ${report.rankCorrelation === null ? 'not computable (fewer than two compared)' : report.rankCorrelation.toFixed(4)}`,
  );
  console.log(`Reports: ${reportJson}${jsonOnly ? '' : `, ${reportMd}`}`);
  console.log('POLICY UNCHANGED: this run is a report. It cannot and did not move the shipped weights.');

  if (delta.identical) {
    // The failure the reframing of #23 exists to prevent. Sprint 04 collapsed
    // agendaScoring into this scorer, so "current ordering versus Priority v1"
    // is now one policy against itself: guaranteed zero disagreement, and
    // guaranteed to say nothing at all.
    console.error('REFUSED: the candidate policy is identical to the baseline. This run measures nothing.');
    console.error('Pass --weight <key>=<number> to compare a real candidate.');
    process.exitCode = 1;
    return;
  }
  if (report.comparedCount === 0) {
    console.error('REFUSED: the sample selected no commitments. Raise --rate.');
    process.exitCode = 1;
    return;
  }
  console.log('RUN COMPLETE.');
}

main().catch((error) => {
  console.error('Priority shadow run failed:', error);
  process.exitCode = 1;
});
