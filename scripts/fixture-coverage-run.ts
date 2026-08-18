/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Life-State / runtime-memory fixture coverage CLI. Validates the fixture
 * corpus, reports coverage across language × context-condition, and proves the
 * validator still rejects every seeded malformed fixture.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/fixture-coverage-run.ts
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/fixture-coverage-run.ts --json-only
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFixtureCoverageReport,
  generateFixtureCoverageMarkdown,
} from '../lib/quality/fixtureCoverageReport';

const jsonOnly = process.argv.includes('--json-only');

async function main(): Promise<void> {
  const report = buildFixtureCoverageReport();

  const reportDir = join(process.cwd(), 'docs', 'quality', 'reports');
  mkdirSync(reportDir, { recursive: true });

  const mdPath = join(reportDir, 'life-state-memory-fixture-coverage.md');
  const jsonPath = join(reportDir, 'life-state-memory-fixture-coverage.json');
  if (!jsonOnly) writeFileSync(mdPath, generateFixtureCoverageMarkdown(report));
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log('=== Life-State & Memory Fixture Coverage ===');
  console.log(
    `Fixtures: ${report.totalFixtures} | Valid: ${report.validFixtures} | Invalid: ${report.invalidFixtures} | Gaps: ${report.gaps.length}`,
  );
  console.log(
    `Memory records: ${report.totalMemoryRecords} | Sensitive: ${report.totalSensitiveRecords} | Bidirectional strings: ${report.totalBidirectionalStrings}`,
  );
  const detected = report.seededFailures.filter((outcome) => outcome.detected).length;
  console.log(`Seeded-failure test: ${report.seededFailureTested ? 'PASS' : 'FAIL'} — ${detected}/${report.seededFailures.length} malformed fixtures rejected`);

  for (const language of report.languages) {
    const row = report.conditions
      .map((condition) => {
        const cell = report.matrix[language]?.[condition];
        return `${condition}=${cell && cell.fixtureIds.length > 0 ? cell.fixtureIds.length : 'GAP'}`;
      })
      .join(' ');
    console.log(`  ${language.padEnd(6)} ${row}`);
  }

  for (const gap of report.gaps) {
    console.error(`GAP: ${gap.language} × ${gap.condition} — ${gap.reason}`);
  }
  for (const issue of report.corpusIssues) {
    console.error(`ISSUE: ${issue}`);
  }
  for (const outcome of report.seededFailures.filter((o) => !o.detected)) {
    console.error(`SEEDED FAILURE NOT DETECTED: ${outcome.caseId} — ${outcome.detail}`);
  }

  if (!jsonOnly) console.log(`Report: ${mdPath}`);

  if (report.status !== 'GATE PASSED') {
    console.error('GATE FAILED: coverage gaps, invalid fixtures, or an undetected seeded failure.');
    process.exitCode = 1;
    return;
  }
  console.log('GATE PASSED (full matrix, every fixture valid, validator proven to reject).');
}

main().catch((error) => {
  console.error('Fixture coverage run failed:', error);
  process.exitCode = 1;
});
