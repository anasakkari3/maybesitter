#!/usr/bin/env node
/**
 * Runs the corrected blind intra-reviewer consistency gate.
 *
 * Replaces scripts/gemma-calibration/consistency_review.py's `report` command.
 * That version read `completion.segments` and `completion.commitmentCount`,
 * fields the review completion has never contained, so boundary and
 * commitment-count agreement reported `compared: 0, rate: null` and the
 * multi-commitment gate failed open. This version reads boundaries from the
 * per-item Gold file where they actually live, and treats an unmeasurable
 * dimension as a gate failure rather than a null.
 *
 * The calibration data lives in the Gemma pipeline working copy, not here:
 *
 *   node --loader ./scripts/ts-resolver.mjs scripts/calibration-consistency.mjs \
 *     --calibration-root ../maybesitter-gemma-gold-calibration \
 *     --out data/calibration/consistency-gate-report.json
 *
 * Exit codes: 0 gate passes (possibly provisionally), 1 gate fails, 2 usage/IO.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { buildDecisionPairs } from '../lib/calibration/consistency.ts';
import { evaluateConsistencyGate } from '../lib/calibration/gate.ts';
import { validateAdjudications } from '../lib/calibration/adjudication.ts';
import { validateAnnotationPolicyRegistry } from '../lib/calibration/policy.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const SOURCES = {
  decisions: 'data/review/gold-decisions.jsonl',
  secondPass: 'data/review/calibration/consistency-second-pass.jsonl',
  blindManifest: 'data/review/calibration/consistency-10-manifest.json',
  perItem: 'data/review/per-item-gold.jsonl',
};

function fail(message) {
  console.error(`${RED}${message}${RESET}`);
  process.exit(2);
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      flags[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return flags;
}

function readText(filePath) {
  if (!existsSync(filePath)) fail(`missing input: ${filePath}`);
  return readFileSync(filePath, 'utf8');
}

function readJsonl(filePath) {
  return readText(filePath)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function checksum(text) {
  return { algorithm: 'sha256', value: createHash('sha256').update(text).digest('hex') };
}

function toReviewDecision(row) {
  let completion = null;
  try {
    completion = row.completion ? JSON.parse(row.completion) : null;
  } catch {
    completion = null;
  }
  return { sourceQueueId: row.source_id, decision: row.decision, completion };
}

function toPerItemAnnotation(row) {
  return {
    sourceQueueId: row.sourceQueueId,
    reviewerId: row.reviewerId,
    itemCount: row.itemCount,
    items: row.items,
  };
}

function reportValidation(label, result) {
  for (const issue of result.issues) {
    const color = issue.severity === 'error' ? RED : YELLOW;
    console.log(`${color}${issue.severity.toUpperCase()} ${issue.code}${RESET} ${issue.path}\n    ${issue.message}`);
  }
  if (!result.valid) fail(`${label} is invalid`);
  console.log(`${label}: ${GREEN}ok${RESET}`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const calibrationRoot = flags['calibration-root'];
  if (!calibrationRoot) {
    fail('--calibration-root <path to the Gemma calibration working copy> is required');
  }
  const root = path.resolve(repoRoot, calibrationRoot);

  const policies = JSON.parse(readText(path.join(repoRoot, 'data/calibration/annotation-policy.json')));
  reportValidation('annotation policy', validateAnnotationPolicyRegistry(policies));

  const decisionsText = readText(path.join(root, SOURCES.decisions));
  const secondText = readText(path.join(root, SOURCES.secondPass));
  const manifestText = readText(path.join(root, SOURCES.blindManifest));
  const perItemText = readText(path.join(root, SOURCES.perItem));

  const decisionRows = decisionsText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const secondRows = secondText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const blindManifest = JSON.parse(manifestText);
  const perItemRows = perItemText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

  const blindSourceIds = blindManifest.entries.map((entry) => entry.sourceQueueId);
  const pairs = buildDecisionPairs(
    decisionRows.map(toReviewDecision),
    secondRows.map(toReviewDecision),
    blindSourceIds,
  );

  const disagreedSourceIds = pairs.filter((pair) => !pair.agrees).map((pair) => pair.sourceQueueId);
  const adjudications = readJsonl(path.join(repoRoot, 'data/calibration/adjudications.jsonl'));
  reportValidation(
    'adjudications',
    validateAdjudications(adjudications, { policies, disagreedSourceIds }),
  );

  // The gate report is a locked artifact once a freeze cites it, so re-running
  // must not change its bytes just because the clock moved.
  const outPath = flags.out ? path.resolve(repoRoot, flags.out) : null;
  const previous = outPath && existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;

  const report = evaluateConsistencyGate({
    reportId: flags['report-id'] ?? previous?.reportId ?? 'capture-gold-consistency-v2',
    createdAt: flags['created-at'] ?? previous?.createdAt ?? new Date().toISOString(),
    inputs: [
      { name: 'gold-decisions', path: SOURCES.decisions, checksum: checksum(decisionsText), recordCount: decisionRows.length },
      { name: 'consistency-second-pass', path: SOURCES.secondPass, checksum: checksum(secondText), recordCount: secondRows.length },
      { name: 'consistency-10-manifest', path: SOURCES.blindManifest, checksum: checksum(manifestText), recordCount: blindSourceIds.length },
      { name: 'per-item-gold', path: SOURCES.perItem, checksum: checksum(perItemText), recordCount: perItemRows.length },
    ],
    pairs,
    adjudications,
    perItemAnnotations: perItemRows.map(toPerItemAnnotation),
  });

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, serialized, 'utf8');
    console.log(`${DIM}wrote ${path.relative(repoRoot, outPath)}${RESET}`);
  }

  console.log('');
  console.log(`compared items: ${report.comparedItems}`);
  console.log(`classification: ${JSON.stringify(report.classification)}`);
  printDimension('raw decision', report.rawDecisionAgreement);
  printDimension('policy-normalized decision', report.policyNormalizedDecisionAgreement);
  for (const dimension of report.perItemAgreement) printDimension(dimension.dimension, dimension);

  for (const failure of report.failures) console.log(`${RED}FAIL${RESET} ${failure}`);
  for (const proviso of report.provisos) console.log(`${YELLOW}PROVISO${RESET} ${proviso}`);

  const color = report.status === 'fail' ? RED : report.status === 'pass' ? GREEN : YELLOW;
  console.log(`\ngate: ${color}${report.status}${RESET}`);

  process.exit(report.status === 'fail' ? 1 : 0);
}

function printDimension(label, dimension) {
  if (!dimension.measurable) {
    console.log(`  ${RED}${label}: UNMEASURABLE (0 comparisons)${RESET}`);
    return;
  }
  const interval = dimension.confidenceInterval
    ? ` ${DIM}[95% CI ${dimension.confidenceInterval[0].toFixed(3)}–${dimension.confidenceInterval[1].toFixed(3)}]${RESET}`
    : '';
  const power = dimension.underpowered ? ` ${YELLOW}underpowered${RESET}` : '';
  console.log(
    `  ${label}: ${dimension.rate.toFixed(4)} (${dimension.matches}/${dimension.compared})${interval}${power}`,
  );
}

main();
