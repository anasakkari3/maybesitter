/**
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE
 *
 * Alpha quality harness CLI. Runs the synthetic scenario corpus through the
 * real deterministic pipeline and writes a human-readable review report.
 *
 * Usage:
 *   npm run quality:alpha
 *   npm run quality:alpha -- --json-only
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  generateMarkdownReport,
  runAlphaQualityHarness,
  runSeededFailureTest,
} from '../lib/quality/alphaQualityHarness';

const jsonOnly = process.argv.includes('--json-only');

async function main(): Promise<void> {
  const report = runAlphaQualityHarness();
  const seeded = runSeededFailureTest();
  report.seededFailureTested = seeded.passed;

  const reportDir = join(process.cwd(), 'docs', 'quality', 'reports');
  mkdirSync(reportDir, { recursive: true });

  const mdPath = join(reportDir, 'alpha-quality-latest.md');
  const jsonPath = join(reportDir, 'alpha-quality-latest.json');
  writeFileSync(mdPath, generateMarkdownReport(report));
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log('=== Alpha Quality Harness ===');
  console.log(`Scenarios: ${report.totalScenarios} | Passed: ${report.passed} | Failed: ${report.failed} | Pass rate: ${report.passRate}%`);
  console.log(`Status: ${report.status}`);
  console.log(`Seeded-failure test: ${seeded.passed ? 'PASS' : 'FAIL'} — ${seeded.detail}`);
  if (Object.keys(report.failuresByTaxonomy).length > 0) {
    console.log('Failures by taxonomy:', JSON.stringify(report.failuresByTaxonomy));
  }
  console.log(`Report: ${mdPath}`);

  // P0 failures fail the gate.
  const hasP0 = Object.keys(report.failuresBySeverity).includes('P0') && report.failuresBySeverity['P0'] > 0;
  if (hasP0 || !seeded.passed) {
    console.error('GATE FAILED: P0 failures present or seeded-failure test did not pass.');
    process.exitCode = 1;
    return;
  }
  console.log('GATE PASSED (no P0 failures; seeded-failure classifier verified).');
}

main().catch((error) => {
  console.error('Alpha quality harness failed:', error);
  process.exitCode = 1;
});
