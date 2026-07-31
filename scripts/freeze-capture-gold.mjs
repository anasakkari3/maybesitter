#!/usr/bin/env node
/**
 * Builds or verifies the versioned Capture Gold freeze manifest.
 *
 * The manifest never copies or rewrites a human decision. It checksums each
 * canonical decision line in place, so the reviewer's own file stays the single
 * source of truth and any later edit to it is detectable. A source whose
 * adjudication says it still needs re-annotation is excluded with its reason
 * recorded, rather than frozen in a known-bad state.
 *
 * Freezing never starts training. The manifest asserts trainingStarted: false
 * and validation rejects any other value.
 *
 *   node --loader ./scripts/ts-resolver.mjs scripts/freeze-capture-gold.mjs \
 *     --calibration-root ../maybesitter-gemma-gold-calibration [--check]
 *
 * Exit codes: 0 ok, 1 validation failure, 2 usage/IO.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { buildGoldFreezeManifest, validateGoldFreezeManifest } from '../lib/calibration/goldFreeze.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FREEZE_PATH = 'data/calibration/capture-gold-freeze-v2.json';
const DEFAULT_GATE_PATH = 'data/calibration/consistency-gate-report-v2.json';

const DECISIONS = 'data/review/gold-decisions.jsonl';
const PER_ITEM = 'data/review/per-item-gold.jsonl';
const SECOND_PASSES = ['data/review/calibration/consistency-30-second-pass.jsonl', 'data/review/calibration/consistency-extra-8-second-pass.jsonl'];
const ADJUDICATIONS = ['data/review/calibration/consistency-30-adjudications.jsonl', 'data/review/calibration/consistency-extra-8-adjudications.jsonl'];
const CORRECTION = 'data/review/calibration/hebrew-039-reannotation.jsonl';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function fail(message) {
  console.error(`${RED}${message}${RESET}`);
  process.exit(2);
}

function readText(filePath) {
  if (!existsSync(filePath)) fail(`missing input: ${filePath}`);
  return readFileSync(filePath, 'utf8');
}

function checksum(text) {
  return { algorithm: 'sha256', value: createHash('sha256').update(text).digest('hex') };
}

function parseArgs(argv) {
  const flags = { check: argv.includes('--check') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--') && argv[index] !== '--check') {
      flags[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags['calibration-root']) {
    fail('--calibration-root <path to the Gemma calibration working copy> is required');
  }
  const root = path.resolve(repoRoot, flags['calibration-root']);
  const freezePath = path.resolve(repoRoot, flags.out ?? DEFAULT_FREEZE_PATH);
  const gatePath = path.resolve(repoRoot, flags.gate ?? DEFAULT_GATE_PATH);

  const decisionsText = readText(path.join(root, DECISIONS));
  const perItemText = [readText(path.join(root, PER_ITEM)), readText(path.join(root, CORRECTION))].join('');
  const gateReport = JSON.parse(readText(gatePath));

  const decisionLines = new Map();
  const decisions = [];
  for (const line of decisionsText.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    // Append-only file: a later line for the same source wins.
    decisionLines.set(row.source_id, line);
    const existing = decisions.findIndex((d) => d.sourceQueueId === row.source_id);
    const entry = { sourceQueueId: row.source_id, decision: row.decision, completion: null };
    if (existing >= 0) decisions[existing] = entry;
    else decisions.push(entry);
  }

  const perItemAnnotations = perItemText
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const row = JSON.parse(line);
      return {
        sourceQueueId: row.sourceQueueId,
        reviewerId: row.reviewerId,
        itemCount: row.itemCount,
        items: row.items,
      };
    });

  const adjudications = ADJUDICATIONS.flatMap((source) => readText(path.join(root, source)).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)));

  const secondLines = new Map();
  for (const source of SECOND_PASSES) {
    for (const line of readText(path.join(root, source)).split('\n').filter((value) => value.trim())) {
      const row = JSON.parse(line);
      secondLines.set(row.source_id, line);
    }
  }
  for (const adjudication of adjudications.filter((row) => row.dimension === 'decision' && row.canonicalPass === 'second')) {
    const line = secondLines.get(adjudication.sourceQueueId);
    if (!line) fail(`missing canonical second-pass decision for ${adjudication.sourceQueueId}`);
    const row = JSON.parse(line);
    const index = decisions.findIndex((decision) => decision.sourceQueueId === row.source_id);
    decisions[index] = { sourceQueueId: row.source_id, decision: row.decision, completion: null };
    decisionLines.set(row.source_id, line);
  }

  // A freeze manifest is a locked artifact: re-running the builder must not
  // change its bytes just because the clock moved. An existing manifest's
  // frozenAt is reused unless the caller overrides it explicitly.
  const previous = existsSync(freezePath) ? JSON.parse(readFileSync(freezePath, 'utf8')) : null;

  const manifest = buildGoldFreezeManifest({
    freezeId: flags['freeze-id'] ?? previous?.freezeId ?? 'capture-gold-freeze-v2',
    version: flags.version ?? previous?.version ?? '2.0.0',
    frozenAt: flags['frozen-at'] ?? previous?.frozenAt ?? new Date().toISOString(),
    frozenBy: flags['frozen-by'] ?? 'model-data track',
    authorizingIssue: 'https://github.com/anasakkari3/maybesitter/issues/5',
    policyVersion: flags['policy-version'] ?? '2.1.0',
    gateReport,
    inputs: [
      { name: 'gold-decisions', path: DECISIONS, checksum: checksum(decisionsText), recordCount: decisions.length },
      { name: 'per-item-gold-plus-correction', path: `${PER_ITEM}+${CORRECTION}`, checksum: checksum(perItemText), recordCount: perItemAnnotations.length },
    ],
    decisions,
    decisionLines,
    adjudications,
    perItemAnnotations,
  });

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

  if (flags.check) {
    if (!existsSync(freezePath)) fail('no freeze manifest to check');
    const existing = JSON.parse(readFileSync(freezePath, 'utf8'));
    const result = validateGoldFreezeManifest(existing, { decisionLines, gateReport });
    for (const issue of result.issues) {
      const color = issue.severity === 'error' ? RED : YELLOW;
      console.log(`${color}${issue.severity.toUpperCase()} ${issue.code}${RESET} ${issue.path}\n    ${issue.message}`);
    }
    if (!result.valid) {
      console.log(`freeze: ${RED}invalid${RESET}`);
      process.exit(1);
    }
    console.log(
      `freeze: ${GREEN}ok${RESET} — ${existing.includedCount} included, ${existing.excludedCount} excluded, records checksum ${existing.recordsChecksum.value}`,
    );
    process.exit(0);
  }

  mkdirSync(path.dirname(freezePath), { recursive: true });
  writeFileSync(freezePath, serialized, 'utf8');
  console.log(
    `wrote ${path.relative(repoRoot, freezePath)} — ${manifest.includedCount} included, ${manifest.excludedCount} excluded`,
  );
  console.log(`records checksum: ${manifest.recordsChecksum.value}`);
  for (const record of manifest.records.filter((r) => r.excluded)) {
    console.log(`${YELLOW}excluded${RESET} ${record.sourceQueueId}: ${record.exclusionReason}`);
  }
}

main();
