/**
 * Priority annotation status CLI (Sprint 04, issue #19).
 *
 * Reports the seed-set distribution, verifies the checksum lock on the held-out
 * evaluation split, loads whatever judgments exist, and writes the agreement
 * report as markdown plus JSON under docs/quality/reports/.
 *
 * Today it will report an **empty judgment corpus**, and that is the expected
 * outcome, not a failure: Sprint 04 ships the ingestion point wired and
 * unpopulated. What *is* a failure is a coverage gap, a malformed judgment row,
 * or a locked split that no longer matches its checksum.
 *
 * Shape mirrors scripts/fixture-coverage-run.ts.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-agreement-run.ts
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/priority-agreement-run.ts --json-only
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildAgreementReport,
  generateAgreementMarkdown,
} from '../lib/priority/rubric/agreementReport';
import { JUDGMENT_CORPUS_PATH, loadShippedJudgmentCorpus } from '../lib/priority/rubric/judgmentCorpus';
import {
  buildSeedSetCoverageReport,
  generateSeedSetCoverageMarkdown,
} from '../lib/priority/rubric/seedSetCoverage';
import { verifySeedSetLock } from '../lib/priority/rubric/seedSetLock';
import { formatIssue } from '../lib/evaluation/registry/validationPrimitives';

const jsonOnly = process.argv.includes('--json-only');

async function main(): Promise<void> {
  const coverage = buildSeedSetCoverageReport();
  const lock = verifySeedSetLock();
  const loaded = loadShippedJudgmentCorpus();
  const agreement = buildAgreementReport(loaded.judgments);

  const reportDir = join(process.cwd(), 'docs', 'quality', 'reports');
  mkdirSync(reportDir, { recursive: true });

  const distributionJson = join(reportDir, 'priority-seed-set-distribution.json');
  const distributionMd = join(reportDir, 'priority-seed-set-distribution.md');
  const agreementJson = join(reportDir, 'priority-annotation-agreement.json');
  const agreementMd = join(reportDir, 'priority-annotation-agreement.md');

  writeFileSync(distributionJson, `${JSON.stringify(coverage, null, 2)}\n`);
  writeFileSync(agreementJson, `${JSON.stringify(agreement, null, 2)}\n`);
  if (!jsonOnly) {
    writeFileSync(distributionMd, `${generateSeedSetCoverageMarkdown(coverage)}\n`);
    writeFileSync(agreementMd, `${generateAgreementMarkdown(agreement)}\n`);
  }

  console.log('=== Priority Annotation Status ===');
  console.log(
    `Seed pairs: ${coverage.totalPairs} | Locked: ${coverage.lockedPairCount} | ` +
      `Designed-ambiguous: ${coverage.designedAmbiguousTotal} | Gaps: ${coverage.gaps.length}`,
  );
  for (const language of coverage.languages) {
    const row = coverage.loadPatterns
      .map((loadPattern) => {
        const cell = coverage.matrix[language]?.[loadPattern];
        return `${loadPattern}=${cell && cell.pairIds.length > 0 ? cell.pairIds.length : 'GAP'}`;
      })
      .join(' ');
    console.log(`  ${language.padEnd(6)} ${row}`);
  }
  console.log(`Locked-split checksum: ${lock.valid ? 'VERIFIED' : 'FAILED'}`);
  console.log(`Judgment corpus: ${JUDGMENT_CORPUS_PATH}`);
  console.log(`Judgments: ${agreement.judgmentCount} | Annotators: ${agreement.annotatorCount}`);

  if (agreement.corpusEmpty) {
    console.log(
      'CORPUS EMPTY: no human annotation has been collected. The ingestion point is wired and unpopulated,',
    );
    console.log('which is the expected Sprint 04 state — see docs/quality/PRIORITY_ANNOTATION_RUBRIC.md §9.');
  } else {
    const agreementText =
      agreement.observedAgreement === null
        ? 'not computable (no pair carries two resolving verdicts)'
        : `${(agreement.observedAgreement * 100).toFixed(1)}% over ${agreement.scorablePairCount}/${agreement.pairCount} pairs`;
    console.log(`Observed agreement: ${agreementText}`);
    console.log(`Unresolved: ${agreement.unresolvedCount} | Disagreements: ${agreement.disagreements.length}`);
  }

  for (const gap of coverage.gaps) {
    console.error(`GAP: ${gap.language} × ${gap.loadPattern} — ${gap.reason}`);
  }
  for (const mix of coverage.uncoveredReasonMixes) {
    console.error(`UNCOVERED REASON MIX: ${mix}`);
  }
  for (const imbalance of coverage.imbalances) {
    console.warn(
      `IMBALANCE: ${imbalance.language} × ${imbalance.loadPattern} has ${imbalance.pairCount} pairs ` +
        `against a mean of ${imbalance.meanPairsPerCell.toFixed(2)} (${imbalance.direction})`,
    );
  }
  for (const issue of lock.issues) console.error(`LOCK: ${formatIssue(issue)}`);
  for (const issue of loaded.issues) console.error(`JUDGMENT: ${formatIssue(issue)}`);

  if (!jsonOnly) {
    console.log(`Reports: ${distributionMd}, ${agreementMd}`);
  }

  if (coverage.status !== 'GATE PASSED' || !lock.valid || !loaded.valid) {
    console.error('GATE FAILED: a coverage gap, a broken split lock, or a malformed judgment row.');
    process.exitCode = 1;
    return;
  }
  console.log('GATE PASSED (full matrix, locked split verified, judgment corpus loads cleanly).');
}

main().catch((error) => {
  console.error('Priority agreement run failed:', error);
  process.exitCode = 1;
});
