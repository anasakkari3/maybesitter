/**
 * Priority calibration CLI (Sprint 05, issue #22).
 *
 * Runs the calibration pipeline against whatever judgments exist, writes the
 * report as JSON and markdown under docs/quality/reports/, and puts the shipped
 * policy through the single-use locked-split gate.
 *
 * **Today it will report an empty corpus and a refused gate, and that is the
 * expected outcome, not a failure.** `data/quality/priority-judgments.json`
 * carries zero rows. The pipeline exists so that the first real annotation run
 * needs no code change; the gate refuses rather than reporting a vacuous pass,
 * because a "passed" over zero judgments is confidence manufactured out of an
 * absence of data.
 *
 * **This CLI cannot change the shipped policy.** It writes two report files and
 * nothing else. Shipping a calibrated weight is a human edit to
 * `lib/priority/priorityPolicy.ts` plus a deliberate change to the freeze test
 * that pins it.
 *
 * The clock lives here. Everything under `lib/priority/**` takes `generatedAt`
 * as a parameter, so an unchanged corpus produces an unchanged report body.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts --seed=12345
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts --replay=<report.json>
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-calibrate.ts --used-split=<id>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildSeedCorpus,
  generateCalibrationMarkdown,
  runCalibration,
  runCalibrationFromManifest,
  runLockedGate,
  serializeCalibrationReport,
} from '../lib/priority/calibration';
import type { CalibrationManifest } from '../src/contracts/v1/calibrationContracts';
import { DEFAULT_PRIORITY_POLICY } from '../lib/priority/priorityPolicy';
import { loadShippedJudgmentCorpus } from '../lib/priority/rubric/judgmentCorpus';
import { formatIssue } from '../lib/evaluation/registry/validationPrimitives';

/**
 * The default search seed, fixed rather than random.
 *
 * A CLI that seeded itself from the clock would produce a different candidate
 * order on every invocation, which is precisely the reproducibility the
 * manifest exists to provide. Override with `--seed=` when exploring; the value
 * used is recorded in the manifest either way.
 */
const DEFAULT_SEARCH_SEED = 20_260_819;

/** The locked split must clear this before it certifies anything. */
const DEFAULT_MINIMUM_CONCORDANCE = 0.8;

/** The seed-set lock names the split version; the gate records that name as spent. */
const LOCKED_SPLIT_ID = 'priority-seed-split-v1';

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function flagValues(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.filter((argument) => argument.startsWith(prefix)).map((argument) => argument.slice(prefix.length));
}

async function main(): Promise<void> {
  const jsonOnly = process.argv.includes('--json-only');
  const replayPath = flagValue('replay');
  const seedFlag = flagValue('seed');
  const searchSeed = seedFlag === null ? DEFAULT_SEARCH_SEED : Number.parseInt(seedFlag, 10);
  const minimumFlag = flagValue('min-concordance');
  const minimumConcordance = minimumFlag === null ? DEFAULT_MINIMUM_CONCORDANCE : Number.parseFloat(minimumFlag);
  const usedSplitIds = flagValues('used-split');

  const loaded = loadShippedJudgmentCorpus();
  // Declared by the corpus file, never guessed from whether rows exist.
  const provenance = loaded.provenance ?? 'synthetic_pipeline_proof';
  const calibrationCorpus = buildSeedCorpus({ split: 'calibration', judgments: loaded.judgments, provenance });
  const lockedCorpus = buildSeedCorpus({ split: 'locked', judgments: loaded.judgments, provenance });

  // The gate runs first: whether it consumed the locked split is a fact the
  // manifest has to carry, and a manifest written before the gate ran could not
  // state it.
  const gate = runLockedGate({
    splitId: LOCKED_SPLIT_ID,
    corpus: lockedCorpus,
    policy: DEFAULT_PRIORITY_POLICY,
    minimumConcordance,
    usedSplitIds,
  });
  const gateConsumedSplit = gate.usedSplitIds.length > usedSplitIds.length;

  const report = (() => {
    if (replayPath === null) {
      // The CLI owns the clock. Nothing under lib/priority reads one.
      return runCalibration({
        corpus: calibrationCorpus,
        basePolicy: DEFAULT_PRIORITY_POLICY,
        generatedAt: new Date().toISOString(),
        searchSeed,
        lockedSplitUsed: gateConsumedSplit,
      });
    }
    const stored = JSON.parse(readFileSync(replayPath, 'utf8')) as { manifest?: CalibrationManifest };
    if (stored.manifest === undefined) {
      throw new Error(`replay: ${replayPath} carries no manifest`);
    }
    return runCalibrationFromManifest(stored.manifest, {
      corpus: calibrationCorpus,
      basePolicy: DEFAULT_PRIORITY_POLICY,
    });
  })();

  const reportDir = join(process.cwd(), 'docs', 'quality', 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportJson = join(reportDir, 'priority-calibration.json');
  const reportMd = join(reportDir, 'priority-calibration.md');

  // Canonical bytes, so an unchanged run produces an unchanged file.
  writeFileSync(reportJson, `${serializeCalibrationReport(report)}\n`);
  if (!jsonOnly) writeFileSync(reportMd, `${generateCalibrationMarkdown(report)}\n`);

  console.log('=== Priority Calibration ===');
  console.log(`Status: ${report.status}`);
  console.log(
    `Corpus: ${calibrationCorpus.pairs.length} pairs | ${calibrationCorpus.judgments.length} judgments | ` +
      `provenance ${calibrationCorpus.provenance}`,
  );
  console.log(`Digest: ${report.manifest.corpusDigest}`);
  console.log(
    `Seed: ${report.manifest.searchSeed} | Candidates evaluated: ${report.manifest.candidatesEvaluated} | ` +
      `Admissible: ${report.admissibleCandidateCount}`,
  );
  console.log(
    `Baseline concordance: ${report.baseline.overall.rate === null ? 'not computable' : report.baseline.overall.rate} ` +
      `over ${report.baseline.overall.scorablePairs} of ` +
      `${report.baseline.overall.scorablePairs + report.baseline.overall.unscorablePairs} pairs`,
  );
  console.log(
    report.best === null
      ? 'Best admissible candidate: none (the shipped weights were not beaten by an admissible candidate).'
      : `Best admissible candidate: ${report.best.policy.version} (rate ${report.best.overall.rate})`,
  );
  if (report.rejectedForConstraintCount > 0) {
    console.log(
      `Rejected for a hard-constraint violation despite beating the baseline: ${report.rejectedForConstraintCount}. ` +
        'A filter, not a penalty: no aggregate gain buys a violation.',
    );
  }
  console.log(`Locked gate [${LOCKED_SPLIT_ID}]: ${gate.result.outcome} — ${gate.result.reason}`);
  if (gateConsumedSplit) {
    console.log(
      `The locked split is now spent. Record it: --used-split=${gate.usedSplitIds.join(' --used-split=')}`,
    );
  }
  console.log('POLICY UNCHANGED: this run wrote two report files and nothing else.');

  for (const issue of loaded.issues) console.error(`JUDGMENT: ${formatIssue(issue)}`);
  if (!jsonOnly) console.log(`Reports: ${reportJson}, ${reportMd}`);

  if (!loaded.valid) {
    console.error('GATE FAILED: the judgment corpus did not load cleanly.');
    process.exitCode = 1;
    return;
  }
  if (gate.result.outcome === 'failed') {
    console.error('GATE FAILED: the shipped policy did not clear the locked split.');
    process.exitCode = 1;
    return;
  }
  if (gate.result.outcome === 'refused_empty_corpus') {
    console.log(
      'GATE REFUSED: the locked split carries no scorable judgment. This is the expected Sprint 05 state — ' +
        'the corpus ships empty, and a pass over zero judgments would be worse than no gate at all.',
    );
  }
}

main().catch((error) => {
  console.error('Priority calibration run failed:', error);
  process.exitCode = 1;
});
